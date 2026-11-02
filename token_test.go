package cerium

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestNewAPIConfiguredToken(t *testing.T) {
	for _, public := range []bool{false, true} {
		t.Run(map[bool]string{false: "account", true: "public"}[public], func(t *testing.T) {
			store := testStore(t)
			var rejected atomic.Int32
			var protected, pricing atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/user/self/groups":
					protected.Add(1)
					if r.Header.Get("Authorization") != "Bearer private-panel-token" || r.Header.Get("New-Api-User") != "42" || r.Header.Get("Cookie") != "" {
						t.Error("configured token or user ID was not used")
					}
					if rejected.Load() != 0 {
						w.WriteHeader(int(rejected.Load()))
						reply(w, `{"success":false,"message":"private-panel-token"}`)
						return
					}
					reply(w, `{"success":true,"data":{"default":{"ratio":2},"private":{"ratio":0.1}}}`)
				case "/api/pricing":
					pricing.Add(1)
					if public && (r.Header.Get("Authorization") != "" || r.Header.Get("New-Api-User") != "" || r.Header.Get("Cookie") != "") {
						t.Error("private credentials leaked to public pricing")
					}
					reply(w, `{"success":true,"usable_group":{"default":"Public"},"group_ratio":{"default":1},"data":[{"model_name":"example","enable_groups":["default"],"quota_type":0,"model_ratio":1}]}`)
				default:
					t.Errorf("token mode must not log in or refresh: %s", r.URL.Path)
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			c := importCredentials(t, store, Credential{URL: server.URL, Type: "newapi", AccessToken: " Bearer private-panel-token ", UserID: 42})[0]
			syncer := &Syncer{Store: store}
			if public {
				syncer.Providers = PublicProviders()
			}
			for range 2 {
				results, err := syncer.Run(context.Background())
				if err != nil || results[0].Refresh != "unsupported" {
					t.Fatalf("token synchronization failed: %v", err)
				}
				if public && (results[0].Catalog.Scope != "public" || len(results[0].Catalog.Groups) != 1 || *results[0].Catalog.Groups[0].Multiplier != 1) {
					t.Fatal("published private groups or rates")
				}
				encoded, _ := json.Marshal(results)
				if bytes.Contains(encoded, []byte(c.AccessToken)) {
					t.Fatal("token leaked in results")
				}
			}
			session, err := store.Session(context.Background(), c.ID)
			if err != nil || session.AccessToken != c.AccessToken || session.UserID != 42 || session.RefreshToken != "" {
				t.Fatal("configured session was not persisted")
			}
			for _, status := range []int32{401, 200, 403} {
				rejected.Store(status)
				results, err := syncer.Run(context.Background())
				if err == nil || !strings.Contains(results[0].Error, "update the configured panel access token") || strings.Contains(err.Error(), c.AccessToken) {
					t.Fatalf("invalid token did not produce a safe actionable error: %v", err)
				}
			}
			if protected.Load() != 5 || pricing.Load() != 2 {
				t.Fatal("invalid token triggered a retry or published guest data")
			}
		})
	}
}

func TestTokenImportAndReplacement(t *testing.T) {
	ctx := context.Background()
	store := testStore(t)
	c := Credential{URL: "https://example.invalid", Type: "newapi", AccessToken: "private-token", UserID: 42}
	first := importCredentials(t, store, c)[0]
	if err := store.SaveSession(ctx, first, Session{AccessToken: c.AccessToken, UserID: 42}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveResult(ctx, first, Result{CheckedAt: time.Now(), Catalog: &Catalog{Groups: []Group{}}}); err != nil {
		t.Fatal(err)
	}
	unchanged := importCredentials(t, store, c)[0]
	if unchanged.ID != first.ID || unchanged.Revision != first.Revision {
		t.Fatal("identical token import changed credential identity")
	}
	c.AccessToken = "replacement-token"
	replaced := importCredentials(t, store, c)[0]
	session, err := store.Session(ctx, first.ID)
	if err != nil || !session.Empty() || replaced.Revision != first.Revision+1 {
		t.Fatal("changed token did not invalidate the session")
	}
	sites, err := store.Sites(ctx)
	if err != nil || sites[0].Snapshot != nil {
		t.Fatal("changed token did not invalidate the snapshot")
	}
	encoded, _ := json.Marshal(sites)
	if bytes.Contains(encoded, []byte(c.AccessToken)) {
		t.Fatal("configured token leaked in CLI output")
	}
	if err := store.SaveSession(ctx, first, Session{AccessToken: "stale"}); !errors.Is(err, ErrCredentialChanged) {
		t.Fatal("stale token session accepted")
	}
	c.UserID = 43
	if len(importCredentials(t, store, c)) != 2 {
		t.Fatal("different users of the same site collided")
	}
	for _, fields := range []string{
		`"access_token":"token"`,
		`"user_id":42`,
		`"access_token":"token","user_id":-1`,
		`"access_token":"token","user_id":1.5`,
		`"access_token":"token\nsecret","user_id":42`,
		`"access_token":"Bearer ","user_id":42`,
		`"access_token":"token","user_id":42,"account":"a","password":"b"`,
		`"access_token":"token","access_token_env":"TOKEN","user_id":42`,
	} {
		if _, err := store.Import(ctx, strings.NewReader(`{"credentials":[{"url":"https://example.invalid","type":"newapi",`+fields+`}]} `)); err == nil {
			t.Fatalf("invalid token configuration accepted: %s", fields)
		}
	}
	t.Setenv("CERIUM_TEST_TOKEN", "environment-token")
	config := `{"credentials":[{"url":"https://env.invalid","type":"newapi","access_token_env":"CERIUM_TEST_TOKEN","user_id":1}]}`
	if _, err := store.Import(ctx, strings.NewReader(config)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Import(ctx, strings.NewReader(strings.Replace(config, `"newapi"`, `"sub2api"`, 1))); err == nil {
		t.Fatal("Sub2API accepted NewAPI token mode")
	}
	t.Setenv("CERIUM_TEST_TOKEN", "")
	if _, err := store.Import(ctx, strings.NewReader(config)); err == nil {
		t.Fatal("empty token environment variable accepted")
	}
}

func TestBridgeTokenModeChanges(t *testing.T) {
	ctx := context.Background()
	store := testStore(t)
	bridge, err := NewBridge(store, "0123456789abcdef0123456789abcdef", &bridgeSink{})
	if err != nil {
		t.Fatal(err)
	}
	j := BridgeJob{SiteID: "site-00000000000001", Revision: 1, Operation: "sync", URL: "https://example.invalid", Type: "newapi", AccessToken: "token", UserID: 42}
	first, err := bridge.configure(ctx, j)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSession(ctx, first, Session{AccessToken: "token", UserID: 42}); err != nil {
		t.Fatal(err)
	}
	j.Revision++
	j.AccessToken = "new-token"
	second, err := bridge.configure(ctx, j)
	if err != nil || second.ID != first.ID || second.Revision != first.Revision+1 {
		t.Fatalf("token update failed: %v", err)
	}
	session, _ := store.Session(ctx, first.ID)
	if !session.Empty() {
		t.Fatal("token update retained an old session")
	}
	j.Revision++
	j.AccessToken, j.UserID, j.Account, j.Password = "", 0, "user", "password"
	third, err := bridge.configure(ctx, j)
	if err != nil || third.ID != first.ID || third.AccessToken != "" || third.Revision != second.Revision+1 {
		t.Fatalf("switching back to password failed: %v", err)
	}
}
