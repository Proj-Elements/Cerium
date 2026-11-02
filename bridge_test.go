package cerium

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestPublicNewAPIPricing(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/pricing" || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Errorf("public request leaked credentials: %s", r.URL.Path)
		}
		reply(w, `{"success":true,"usable_group":{"default":"Public","auto":"Automatic"},"group_ratio":{"default":2,"private":0.1},"auto_groups":["default"],"data":[
		{"model_name":"tokens","enable_groups":["default"],"quota_type":0,"model_ratio":1.5,"completion_ratio":4,"cache_ratio":0,"create_cache_ratio":1.25},
		{"model_name":"request","enable_groups":["default"],"quota_type":1,"model_price":0.1},
		{"model_name":"dynamic","enable_groups":["default"],"quota_type":0,"model_ratio":1,"completion_ratio":1,"billing_mode":"tiered_expr","billing_expr":"p * 2"},
		{"model_name":"hidden","enable_groups":["private"],"quota_type":0,"model_ratio":1,"completion_ratio":1},
		{"model_name":"missing","enable_groups":["default"]}]}`)
	}))
	defer server.Close()
	p, _ := PublicProviders()["newapi"](Credential{URL: server.URL}, time.Second)
	c, err := p.Fetch(context.Background(), &Session{AccessToken: "secret", Cookies: []*http.Cookie{{Name: "secret", Value: "secret"}}})
	if err != nil {
		t.Fatal(err)
	}
	if c.Scope != "public" || len(c.Groups) != 2 {
		t.Fatalf("unexpected public groups: %+v", c)
	}
	for _, g := range c.Groups {
		if len(g.Models) != 4 {
			t.Fatalf("private model leaked: %+v", g)
		}
		for _, p := range g.Prices {
			if g.ID == "auto" {
				if p.Input != nil || p.Request != nil {
					t.Fatal("invented auto price")
				}
				continue
			}
			switch p.Model {
			case "tokens":
				if p.Input == nil || *p.Input != 6 || *p.Output != 24 || *p.CacheRead != 0 || *p.CacheWrite != 7.5 {
					t.Fatalf("wrong price: %+v", p)
				}
			case "request":
				if p.Request == nil || *p.Request != 0.2 {
					t.Fatalf("wrong request price: %+v", p)
				}
			case "dynamic":
				if p.Mode != "dynamic" || p.Input != nil {
					t.Fatal("invented dynamic price")
				}
			case "missing":
				if p.Mode != "unknown" {
					t.Fatal("missing data became zero price")
				}
			}
		}
	}
}

type bridgeSink struct {
	results []Result
	fail    bool
}

func (s *bridgeSink) Publish(_ context.Context, r Result) error {
	s.results = append(s.results, r)
	if s.fail {
		return errors.New("callback unavailable")
	}
	return nil
}

func TestBridgePersistenceRedeliveryAndDeletion(t *testing.T) {
	var logins, refreshes int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/settings/public":
			reply(w, `{"code":0,"data":{"turnstile_enabled":false}}`)
		case "/api/v1/keys":
			if r.Method == "POST" {
				w.WriteHeader(403)
				reply(w, `{"code":403}`)
			} else {
				reply(w, `{"code":0,"data":{"items":[],"total":0}}`)
			}
		case "/api/v1/auth/login":
			logins++
			reply(w, `{"code":0,"data":{"access_token":"access","refresh_token":"refresh"}}`)
		case "/api/v1/auth/refresh":
			refreshes++
			reply(w, `{"code":0,"data":{"access_token":"rotated","refresh_token":"rotated-refresh"}}`)
		case "/api/v1/groups/available":
			reply(w, `{"code":0,"data":[
		{"id":1,"name":"public","rate_multiplier":2,"is_exclusive":false,"subscription_type":"standard"},
		{"id":2,"name":"private","rate_multiplier":0.1,"is_exclusive":true,"subscription_type":"standard"},
		{"id":3,"name":"subscribed","is_exclusive":false,"subscription_type":"subscription"},
		{"id":4,"name":"unknown-visibility"}]}`)
		default:
			t.Errorf("unexpected endpoint: %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer upstream.Close()
	store, err := OpenStore(filepath.Join(t.TempDir(), "store.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	sink := &bridgeSink{fail: true}
	secret := "0123456789abcdef0123456789abcdef"
	bridge, err := NewBridge(store, secret, sink)
	if err != nil {
		t.Fatal(err)
	}
	job := BridgeJob{JobID: "job-00000000000001", SiteID: "site-00000000000001", Revision: 1, Operation: "sync", Name: "Site", URL: upstream.URL, Type: "sub2api", Account: "a", Password: "b"}
	post := func(j BridgeJob, valid bool) int {
		body, _ := json.Marshal(j)
		req := httptest.NewRequest("POST", "/v1/sync", bytes.NewReader(body))
		ts := strconv.FormatInt(time.Now().Unix(), 10)
		mac := hmac.New(sha256.New, []byte(secret))
		mac.Write([]byte(ts + "\n"))
		mac.Write(body)
		req.Header.Set("X-Cerium-Timestamp", ts)
		if valid {
			req.Header.Set("X-Cerium-Signature", "sha256="+hex.EncodeToString(mac.Sum(nil)))
		}
		w := httptest.NewRecorder()
		bridge.ServeHTTP(w, req)
		return w.Code
	}
	if post(job, false) != 401 || post(job, true) != 502 {
		t.Fatal("signature or failed callback not enforced")
	}
	sink.fail = false
	// Recreate the bridge to prove idempotency survives process restarts.
	bridge, _ = NewBridge(store, secret, sink)
	if post(job, true) != 200 || logins != 1 || refreshes != 1 {
		t.Fatalf("redelivery repeated refresh: %d / %d", logins, refreshes)
	}
	result := sink.results[len(sink.results)-1]
	if result.JobID != job.JobID || result.Catalog.Scope != "public" || len(result.Catalog.Groups) != 1 || *result.Catalog.Groups[0].Multiplier != 2 {
		t.Fatalf("unsafe public result: %+v", result)
	}
	job.Password = "changed"
	if post(job, true) != 409 {
		t.Fatal("same job accepted different payload")
	}
	job.JobID, job.Operation, job.Revision = "job-00000000000002", "delete", 2
	if post(job, true) != 200 {
		t.Fatal("delete failed")
	}
	credentials, _ := store.Credentials(context.Background())
	if len(credentials) != 0 {
		t.Fatal("credentials not deleted")
	}
	job.JobID, job.Operation, job.Revision = "job-00000000000003", "sync", 1
	if post(job, true) != 409 {
		t.Fatal("stale revision resurrected credentials")
	}
}
