package cerium

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func reply(w http.ResponseWriter, body string) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, body)
}

func TestSub2APISyncRefreshPersistenceAndSnapshots(t *testing.T) {
	store := testStore(t)
	var logins, refreshes, groupRequests atomic.Int32
	var failGroups atomic.Bool
	keys := map[string]int64{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/settings/public":
			reply(w, `{"code":0,"data":{"turnstile_enabled":false}}`)
		case "/api/v1/auth/login":
			logins.Add(1)
			var body map[string]string
			if r.Method != http.MethodPost || json.NewDecoder(r.Body).Decode(&body) != nil || body["email"] != "user@example.com" || body["password"] != "private-password" {
				t.Error("incorrect Sub2API login request")
			}
			reply(w, `{"code":0,"data":{"access_token":"at-0","refresh_token":"rt-0","expires_in":3600}}`)
		case "/api/v1/auth/refresh":
			n := refreshes.Add(1)
			var body map[string]string
			if r.Method != http.MethodPost || json.NewDecoder(r.Body).Decode(&body) != nil || body["refresh_token"] != fmt.Sprintf("rt-%d", n-1) {
				t.Error("wrong refresh token or repeated rotation")
			}
			reply(w, fmt.Sprintf(`{"code":0,"data":{"access_token":"at-%d","refresh_token":"rt-%d","expires_in":3600}}`, n, n))
		case "/api/v1/groups/available":
			groupRequests.Add(1)
			n := refreshes.Load()
			session, err := store.Session(context.Background(), 1)
			if err != nil || session.RefreshToken != fmt.Sprintf("rt-%d", n) || r.Header.Get("Authorization") != fmt.Sprintf("Bearer at-%d", n) {
				t.Error("rotated tokens were not committed before fetching groups")
			}
			if failGroups.Load() {
				w.WriteHeader(http.StatusServiceUnavailable)
				reply(w, `{"code":503,"message":"private-password private-at private-rt"}`)
				return
			}
			reply(w, `{"code":0,"data":[{"id":2,"name":"beta","platform":"openai","rate_multiplier":0.5},{"id":1,"name":"alpha","platform":"anthropic","rate_multiplier":1.5}]}`)
		case "/api/v1/groups/rates":
			reply(w, `{"code":0,"data":{"1":0,"2":0.7}}`)
		case "/api/v1/keys":
			var body struct {
				Name  string `json:"name"`
				Key   string `json:"custom_key"`
				Group int64  `json:"group_id"`
			}
			if r.Method != "POST" || json.NewDecoder(r.Body).Decode(&body) != nil {
				t.Error("unexpected key operation")
			}
			keys[body.Key] = body.Group
			json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": probeKey{ID: body.Group, GroupID: body.Group, Name: body.Name, Key: body.Key}})
		case "/v1/models":
			if keys[strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")] == 1 {
				reply(w, `{"object":"list","data":[{"id":"model-b"},{"id":"model-a"},{"id":"model-a"}]}`)
			} else {
				reply(w, `{"object":"list","data":[]}`)
			}
		case "/api/v1/keys/1", "/api/v1/keys/2":
			if r.Method != "DELETE" {
				t.Error("unexpected key operation")
			}
			reply(w, `{"code":0,"data":{}}`)
		default:
			t.Errorf("unexpected endpoint %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	c := testCredential()
	c.Type, c.URL = "sub2api", server.URL
	c = importCredentials(t, store, c)[0]
	syncer := &Syncer{Store: store}
	first, err := syncer.Run(context.Background())
	if err != nil || len(first) != 1 || first[0].Refresh != "rotated" {
		t.Fatalf("first synchronization failed: %v", err)
	}
	groups := first[0].Catalog.Groups
	if len(groups) != 2 || groups[0].ID != "1" || groups[0].Multiplier == nil || *groups[0].Multiplier != 0 || *groups[0].DefaultMultiplier != 1.5 || groups[0].MultiplierSource != "user" {
		t.Fatalf("incorrect personalized/default multipliers: %+v", groups)
	}
	if !groups[0].ModelsKnown || !reflect.DeepEqual(groups[0].Models, []string{"model-a", "model-b"}) || !groups[1].ModelsKnown || groups[1].Models == nil || len(groups[1].Models) != 0 {
		t.Fatalf("model mapping is incorrect: %+v", groups)
	}
	failGroups.Store(true)
	second, err := syncer.Run(context.Background())
	if err == nil || second[0].Error == "" || second[0].Refresh != "rotated" || logins.Load() != 1 || refreshes.Load() != 2 || groupRequests.Load() != 2 {
		t.Fatalf("failed fetch did not preserve one-shot authentication: %v", err)
	}
	session, err := store.Session(context.Background(), c.ID)
	if err != nil || session.RefreshToken != "rt-2" || session.AccessToken != "at-2" {
		t.Fatal("fetch failure lost newly rotated tokens")
	}
	sites, err := store.Sites(context.Background())
	if err != nil || sites[0].Snapshot == nil || sites[0].LastRun.Error == "" || !sites[0].FetchedAt.Equal(first[0].CheckedAt) || !reflect.DeepEqual(sites[0].Snapshot, first[0].Catalog) {
		t.Fatalf("last good snapshot was overwritten: %v", err)
	}
	public, _ := json.Marshal(sites)
	for _, secret := range []string{"private-password", "private-at", "private-rt", "rt-2", "at-2"} {
		if bytes.Contains(public, []byte(secret)) || strings.Contains(second[0].Error, secret) {
			t.Fatal("upstream authentication details leaked into public output")
		}
	}
}

func TestSub2APIOptionalRates(t *testing.T) {
	for _, tc := range []struct {
		name       string
		rateStatus int
		rateBody   string
		wantSource string
	}{
		{"null personal rates", 200, `{"code":0,"data":null}`, "group"},
		{"old server lacks optional rates", 404, `{}`, "group_fallback"},
		{"optional service errors", 500, `{"code":500}`, "group_fallback"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/v1/groups/available":
					reply(w, `{"code":0,"data":[{"id":1,"name":"group","rate_multiplier":2.5}]}`)
				case "/api/v1/groups/rates":
					w.WriteHeader(tc.rateStatus)
					reply(w, tc.rateBody)
				default:
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			p, err := NewSub2API(Credential{URL: server.URL}, time.Second)
			if err != nil {
				t.Fatal(err)
			}
			catalog, err := p.Fetch(context.Background(), &Session{AccessToken: "at"})
			if err != nil || len(catalog.Groups) != 1 || *catalog.Groups[0].Multiplier != 2.5 || catalog.Groups[0].MultiplierSource != tc.wantSource || catalog.Groups[0].ModelsKnown || catalog.Groups[0].Models != nil || len(catalog.Warnings) == 0 {
				t.Fatalf("optional metadata incorrectly became fatal or fabricated models: %+v, %v", catalog, err)
			}
		})
	}
}

func TestNewAPIModernTokensCookiesAndGroupModels(t *testing.T) {
	store := testStore(t)
	var logins, refreshes atomic.Int32
	writeAuth := func(w http.ResponseWriter, n int32) {
		http.SetCookie(w, &http.Cookie{Name: "new_api_refresh", Value: fmt.Sprintf("rt-%d", n), Path: "/api/user/auth", MaxAge: 3600, HttpOnly: true})
		reply(w, fmt.Sprintf(`{"success":true,"data":{"access_token":"at-%d","access_expires_at":2000000000,"user":{"id":7},"session":{"sid":"sid-7"}}}`, n))
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/user/login/encryption-key":
			reply(w, `{"success":true,"data":{"enabled":false}}`)
		case "/api/user/login":
			logins.Add(1)
			writeAuth(w, 0)
		case "/api/user/auth/refresh":
			n := refreshes.Add(1)
			cookie, err := r.Cookie("new_api_refresh")
			if err != nil || cookie.Value != fmt.Sprintf("rt-%d", n-1) || r.Header.Get("Origin") != "http://"+r.Host || r.Header.Get("X-Auth-Session") != "sid-7" || r.Method != http.MethodPost {
				t.Error("modern NewAPI refresh cookie, Origin, or session ID is incorrect")
			}
			writeAuth(w, n)
		case "/api/user/self/groups", "/api/pricing":
			if r.Header.Get("Authorization") != fmt.Sprintf("Bearer at-%d", refreshes.Load()) || r.Header.Get("New-Api-User") != "7" {
				t.Error("NewAPI token or user ID was not restored")
			}
			if _, err := r.Cookie("new_api_refresh"); err == nil {
				t.Error("path-scoped refresh cookie leaked to a non-refresh endpoint")
			}
			if r.URL.Path == "/api/user/self/groups" {
				reply(w, `{"success":true,"data":{"default":{"ratio":2,"desc":"standard"},"vip":{"ratio":0,"desc":"personalized"},"auto":{"ratio":"auto","desc":"automatic"}}}`)
			} else {
				reply(w, `{"success":true,"data":[{"model_name":"shared","enable_groups":["all"]},{"model_name":"private","enable_groups":["vip"]},{"model_name":"default-model","enable_groups":["default"]},{"model_name":"hidden-model","enable_groups":["hidden"]},{"model_name":"shared","enable_groups":["default"]}],"group_ratio":{"default":2,"vip":0},"auto_groups":["default","vip"]}`)
			}
		default:
			t.Errorf("unexpected endpoint %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	c := testCredential()
	c.Type, c.URL = "newapi", server.URL
	c = importCredentials(t, store, c)[0]
	for i := range 2 {
		results, err := (&Syncer{Store: store}).Run(context.Background())
		if err != nil || len(results) != 1 || results[0].Refresh != "rotated" {
			t.Fatalf("run %d failed: %v", i+1, err)
		}
		groups := results[0].Catalog.Groups
		if len(groups) != 3 || groups[0].ID != "auto" || groups[0].Multiplier != nil || groups[0].MultiplierSource != "auto" || !groups[0].ModelsKnown || !reflect.DeepEqual(groups[0].Models, []string{"default-model", "private", "shared"}) {
			t.Fatalf("automatic group was fabricated or incorrectly mapped: %+v", groups)
		}
		if *groups[2].Multiplier != 0 || groups[2].DefaultMultiplier != nil || !reflect.DeepEqual(groups[2].Models, []string{"private", "shared"}) {
			t.Fatal("personalized zero ratio or model association is incorrect")
		}
	}
	if logins.Load() != 1 || refreshes.Load() != 2 {
		t.Fatalf("unexpected authentication count: login=%d refresh=%d", logins.Load(), refreshes.Load())
	}
	session, err := store.Session(context.Background(), c.ID)
	if err != nil || session.RefreshToken != "rt-2" || session.SessionID != "sid-7" || len(session.Cookies) != 1 || session.Cookies[0].MaxAge != 0 || session.Cookies[0].Expires.Before(time.Now().Add(59*time.Minute)) {
		t.Fatal("modern refresh state was not persisted with its actual expiry")
	}
}

func TestNewAPILegacyExpiredCookieCannotYieldAnonymousPricing(t *testing.T) {
	store := testStore(t)
	var logins, protected, pricing, anonymous atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/user/login/encryption-key":
			http.NotFound(w, r)
		case "/api/user/login":
			logins.Add(1)
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "valid-session", Path: "/", MaxAge: 3600})
			reply(w, `{"success":true,"data":{"id":7,"username":"user"}}`)
		case "/api/user/self/groups":
			protected.Add(1)
			cookie, err := r.Cookie("session")
			if err != nil || cookie.Value != "valid-session" || r.Header.Get("New-Api-User") != "7" {
				w.WriteHeader(http.StatusUnauthorized)
				reply(w, `{"success":false,"message":"login required"}`)
				return
			}
			reply(w, `{"success":true,"data":{"vip":{"ratio":0.75,"desc":"VIP"}}}`)
		case "/api/pricing":
			pricing.Add(1)
			cookie, err := r.Cookie("session")
			if err != nil || cookie.Value != "valid-session" {
				anonymous.Add(1)
			}
			reply(w, `{"success":true,"data":[{"model_name":"model","enable_groups":["vip"]}],"group_ratio":{"vip":0.75}}`)
		default:
			t.Errorf("unexpected legacy endpoint %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	c := testCredential()
	c.Type, c.URL = "newapi", server.URL
	c = importCredentials(t, store, c)[0]
	if err := store.SaveSession(context.Background(), c, Session{UserID: 7, Cookies: []*http.Cookie{{Name: "session", Value: "expired-session", Path: "/"}}}); err != nil {
		t.Fatal(err)
	}
	results, err := (&Syncer{Store: store}).Run(context.Background())
	if err != nil || results[0].Refresh != "unsupported" || logins.Load() != 1 || protected.Load() != 2 || pricing.Load() != 1 || anonymous.Load() != 0 {
		t.Fatalf("legacy authentication did not recover safely: %v", err)
	}
	if *results[0].Catalog.Groups[0].Multiplier != 0.75 || !reflect.DeepEqual(results[0].Catalog.Groups[0].Models, []string{"model"}) {
		t.Fatal("legacy group metadata is incorrect")
	}
}

func TestNewAPIDisabledPricingStillReturnsGroups(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/user/self/groups" {
			reply(w, `{"success":true,"data":{"default":{"ratio":1,"desc":"default"}}}`)
			return
		}
		w.WriteHeader(http.StatusForbidden)
		reply(w, `{"success":false,"message":"pricing disabled"}`)
	}))
	defer server.Close()
	p, err := NewNewAPI(Credential{URL: server.URL}, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	catalog, err := p.Fetch(context.Background(), &Session{AccessToken: "at"})
	if err != nil || len(catalog.Groups) != 1 || *catalog.Groups[0].Multiplier != 1 || catalog.Groups[0].ModelsKnown || len(catalog.Warnings) != 1 {
		t.Fatalf("disabled pricing lost known group data: %v", err)
	}
}

func TestInteractiveLoginIsReportedWithoutBypass(t *testing.T) {
	for _, tc := range []struct {
		kind string
		body string
	}{
		{"sub2api", `{"code":0,"data":{"requires_2fa":true,"temp_token":"private-temp-token"}}`},
		{"newapi", `{"success":true,"data":{"require_2fa":true}}`},
		{"newapi", `{"success":true,"data":{"require_verification":true,"flow_token":"private-temp-token"}}`},
	} {
		t.Run(tc.kind+tc.body, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/v1/settings/public" {
					reply(w, `{"code":0,"data":{"turnstile_enabled":false}}`)
					return
				}
				if strings.HasSuffix(r.URL.Path, "/encryption-key") {
					reply(w, `{"success":true,"data":{"enabled":false}}`)
					return
				}
				if !strings.HasSuffix(r.URL.Path, "/login") {
					t.Error("unexpected request after interactive authentication challenge")
				}
				reply(w, tc.body)
			}))
			defer server.Close()
			p, err := DefaultProviders()[tc.kind](Credential{URL: server.URL, Account: "user", Password: "password"}, time.Second)
			if err != nil {
				t.Fatal(err)
			}
			if err := p.Login(context.Background(), &Session{}); !errors.Is(err, ErrInteractiveLogin) || strings.Contains(err.Error(), "private-temp-token") {
				t.Fatalf("interactive challenge was not safely reported: %v", err)
			}
		})
	}
}

func TestNewAPIPasswordEncryption(t *testing.T) {
	private, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&private.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	public := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	for _, password := range []string{"short private password", strings.Repeat("long-password-", 30)} {
		t.Run(fmt.Sprintf("%d bytes", len(password)), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "/encryption-key") {
					data, _ := json.Marshal(map[string]any{"success": true, "data": map[string]any{"enabled": true, "kid": "key-1", "public_key": public}})
					reply(w, string(data))
					return
				}
				var body map[string]string
				if json.NewDecoder(r.Body).Decode(&body) != nil || body["password"] != "" || body["encryption_key_id"] != "key-1" {
					t.Error("password was sent in plaintext or key ID was omitted")
				}
				plaintext, err := decryptTestPassword(private, body["password_encrypted"], "key-1")
				if err != nil || plaintext != password {
					t.Errorf("encrypted password does not match upstream format: %v", err)
				}
				reply(w, `{"success":true,"data":{"access_token":"at","user":{"id":7}}}`)
			}))
			defer server.Close()
			p, err := NewNewAPI(Credential{URL: server.URL, Account: "user", Password: password}, time.Second)
			if err != nil {
				t.Fatal(err)
			}
			if err := p.Login(context.Background(), &Session{}); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func decryptTestPassword(key *rsa.PrivateKey, encrypted, kid string) (string, error) {
	if !strings.HasPrefix(encrypted, "v2.") {
		data, err := base64.StdEncoding.DecodeString(encrypted)
		if err != nil {
			return "", err
		}
		plain, err := rsa.DecryptOAEP(sha256.New(), rand.Reader, key, data, nil)
		return string(plain), err
	}
	parts := strings.Split(encrypted, ".")
	if len(parts) != 4 {
		return "", errors.New("invalid hybrid envelope")
	}
	wrapped, err := base64.StdEncoding.DecodeString(parts[1])
	if err != nil {
		return "", err
	}
	secret, err := rsa.DecryptOAEP(sha256.New(), rand.Reader, key, wrapped, []byte("password-v2"))
	if err != nil {
		return "", err
	}
	nonce, err := base64.StdEncoding.DecodeString(parts[2])
	if err != nil {
		return "", err
	}
	sealed, err := base64.StdEncoding.DecodeString(parts[3])
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(secret)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	plain, err := gcm.Open(nil, nonce, sealed, []byte("password-v2:"+kid))
	return string(plain), err
}

func TestNewAPIEncryptionDiscoveryDoesNotDowngradeOnFailure(t *testing.T) {
	var loginRequests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/login") {
			loginRequests.Add(1)
		}
		w.WriteHeader(http.StatusServiceUnavailable)
		reply(w, `{"success":false,"message":"private-password"}`)
	}))
	defer server.Close()
	p, err := NewNewAPI(Credential{URL: server.URL, Password: "private-password"}, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	err = p.Login(context.Background(), &Session{})
	if err == nil || loginRequests.Load() != 0 || strings.Contains(err.Error(), "private-password") {
		t.Fatalf("unsafe plaintext fallback on encryption discovery failure: %v", err)
	}
}
