package cerium

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestConnectionRetryOnlyForSafeReads(t *testing.T) {
	for _, tc := range []struct {
		method  string
		noRetry bool
		want    int
	}{{"GET", false, 2}, {"POST", false, 1}, {"DELETE", false, 1}, {"GET", true, 1}} {
		t.Run(fmt.Sprintf("%s/noRetry=%v", tc.method, tc.noRetry), func(t *testing.T) {
			client, _ := newAPIClient("https://example.invalid", time.Second)
			calls := 0
			client.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) { calls++; return nil, io.EOF })
			_, _, err := client.rawRequest(context.Background(), &Session{AccessToken: "private-token"}, tc.method, "/test", nil, requestOptions{noRetry: tc.noRetry})
			if !errors.Is(err, io.EOF) || calls != tc.want || strings.Contains(err.Error(), "private-token") {
				t.Fatalf("unsafe retry: calls=%d error=%v", calls, err)
			}
		})
	}
	client, _ := newAPIClient("https://example.invalid", time.Second)
	calls := 0
	client.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		if calls == 1 {
			return nil, io.EOF
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"success":true,"data":[]}`))}, nil
	})
	if _, err := client.request(context.Background(), &Session{}, "GET", "/api/pricing", nil); err != nil || calls != 2 {
		t.Fatalf("read did not recover after EOF: %v", err)
	}
}

func TestHTTPEnvelopeErrorsAreNotSuccess(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
		auth   bool
	}{
		{"NewAPI false success", 200, `{"success":false,"code":"AUTH_UNAUTHORIZED","message":"private-secret"}`, true},
		{"Sub2API application error", 200, `{"code":401,"message":"private-secret"}`, true},
		{"HTTP error with valid envelope", 401, `{"code":0,"data":[]}`, true},
		{"HTTP error with HTML", 503, `<html>private-secret</html>`, false},
		{"SPA is not an API", 200, `<html>private-secret</html>`, false},
		{"JSON without success marker", 200, `{"message":"private-secret"}`, false},
		{"trailing JSON", 200, `{"code":0,"data":[]} {}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				reply(w, tc.body)
			}))
			defer server.Close()
			client, err := newAPIClient(server.URL, time.Second)
			if err != nil {
				t.Fatal(err)
			}
			_, err = client.request(context.Background(), &Session{}, http.MethodGet, "/api/test", nil)
			if err == nil || authRejected(err) != tc.auth || strings.Contains(err.Error(), "private-secret") {
				t.Fatalf("unsafe or misclassified API error: %v", err)
			}
		})
	}
}

func TestAPIRequestsDoNotFollowRedirects(t *testing.T) {
	var forwarded atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		forwarded.Add(1)
		reply(w, `{"code":0,"data":[]}`)
	}))
	defer target.Close()
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer origin.Close()
	client, err := newAPIClient(origin.URL, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.request(context.Background(), &Session{AccessToken: "private-at"}, http.MethodPost, "/login", map[string]string{"password": "private-password"})
	if !hasStatus(err, 307) || forwarded.Load() != 0 {
		t.Fatalf("credentials were forwarded across a redirect: %v", err)
	}
}

func TestHTTPResponseLimitAndCancellation(t *testing.T) {
	t.Run("response limit", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.Copy(w, io.LimitReader(strings.NewReader(strings.Repeat("x", maxResponseBytes+1)), maxResponseBytes+1))
		}))
		defer server.Close()
		client, err := newAPIClient(server.URL, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := client.request(context.Background(), &Session{}, http.MethodGet, "/large", nil); err == nil || !strings.Contains(err.Error(), "8 MiB") {
			t.Fatalf("oversized response accepted: %v", err)
		}
	})
	t.Run("cancel in-flight request", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			cancel()
			<-r.Context().Done()
		}))
		defer server.Close()
		client, err := newAPIClient(server.URL, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := client.request(ctx, &Session{}, http.MethodGet, "/wait", nil); !errors.Is(err, context.Canceled) {
			t.Fatalf("request did not respect cancellation: %v", err)
		}
	})
}

func TestURLPrefixAndCookieExpiry(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/panel/api/check" {
			t.Errorf("site URL prefix was lost: %s", r.URL.Path)
		}
		if _, err := r.Cookie("expired"); err == nil {
			t.Error("expired cookie was sent")
		}
		if _, err := r.Cookie("secure"); err == nil {
			t.Error("secure cookie was sent over HTTP")
		}
		http.SetCookie(w, &http.Cookie{Name: "new", Value: "value", MaxAge: 60, Expires: time.Now().Add(-time.Hour)})
		reply(w, `{"code":0,"data":[]}`)
	}))
	defer server.Close()
	client, err := newAPIClient("http://site.example.invalid/panel/", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	target, _ := url.Parse(server.URL)
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, target.Host)
	}
	client.client.Transport = transport
	t.Cleanup(transport.CloseIdleConnections)
	s := Session{Cookies: []*http.Cookie{{Name: "expired", Value: "secret", Path: "/", Expires: time.Now().Add(-time.Hour)}, {Name: "secure", Value: "secret", Path: "/", Secure: true}}}
	if _, err := client.request(context.Background(), &s, http.MethodGet, "/api/check", nil); err != nil {
		t.Fatal(err)
	}
	last := s.Cookies[len(s.Cookies)-1]
	if last.Name != "new" || last.Path != "/panel/api" || last.MaxAge != 0 || !last.Expires.After(time.Now().Add(55*time.Second)) {
		t.Fatal("default cookie path or absolute expiry was not persisted")
	}
	u, _ := url.Parse("http://site.example.invalid/panel/api/check")
	mergeCookies(&s, u, []*http.Cookie{{Name: "new", Path: "/panel/api", MaxAge: -1}})
	for _, c := range s.Cookies {
		if c.Name == "new" {
			t.Fatal("deleted cookie was retained")
		}
	}
}

func TestWebhookSignatureAndPayload(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		body, _ := io.ReadAll(r.Body)
		mac := hmac.New(sha256.New, []byte("hook-secret"))
		mac.Write([]byte(r.Header.Get("X-Cerium-Timestamp") + "\n"))
		mac.Write(body)
		if r.Method != http.MethodPost || r.Header.Get("X-Cerium-Event") != "sync.completed" || r.Header.Get("X-Cerium-Signature") != "sha256="+hex.EncodeToString(mac.Sum(nil)) {
			t.Error("webhook signature or headers are incorrect")
		}
		var result Result
		if json.Unmarshal(body, &result) != nil || result.CredentialID != 1 || bytes.Contains(body, []byte("password")) || bytes.Contains(body, []byte("access_token")) || bytes.Contains(body, []byte("refresh_token")) {
			t.Error("webhook payload is invalid or includes private fields")
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	webhook, err := NewWebhook(server.URL, "hook-secret", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if err := webhook.Publish(context.Background(), Result{CredentialID: 1, Name: "site", Refresh: "rotated"}); err != nil || calls.Load() != 1 {
		t.Fatalf("webhook failed or retried: %v", err)
	}
}

func TestWebhookDoesNotFollowRedirectsOrEchoItsURL(t *testing.T) {
	var forwarded atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { forwarded.Add(1) }))
	defer target.Close()
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/private-webhook-token", http.StatusTemporaryRedirect)
	}))
	defer origin.Close()
	webhook, err := NewWebhook(origin.URL+"/private-webhook-token", "", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	err = webhook.Publish(context.Background(), Result{})
	if err == nil || forwarded.Load() != 0 || strings.Contains(err.Error(), "private-webhook-token") {
		t.Fatalf("webhook redirect or URL disclosure: %v", err)
	}
	origin.Close()
	err = webhook.Publish(context.Background(), Result{})
	if err == nil || strings.Contains(err.Error(), "private-webhook-token") {
		t.Fatalf("failed request exposed webhook URL: %v", err)
	}
}

type sinkFunc func(context.Context, Result) error

func (f sinkFunc) Publish(ctx context.Context, r Result) error { return f(ctx, r) }

func TestWebhookFailureDoesNotRollbackSnapshot(t *testing.T) {
	store := testStore(t)
	importCredentials(t, store, testCredential())
	syncer := Syncer{Store: store, Providers: registryFor(&stubProvider{}), Sinks: []Sink{sinkFunc(func(context.Context, Result) error { return errors.New("delivery failed") })}}
	results, err := syncer.Run(context.Background())
	if err == nil || len(results) != 1 || results[0].Error != "" || results[0].Catalog == nil {
		t.Fatal("webhook failure was not separated from synchronization success")
	}
	sites, err := store.Sites(context.Background())
	if err != nil || sites[0].Snapshot == nil || sites[0].LastRun.Error != "" {
		t.Fatal("webhook failure discarded the snapshot")
	}
}
