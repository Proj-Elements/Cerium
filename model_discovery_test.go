package cerium

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestGatewayModelsOnceAndRecovery(t *testing.T) {
	for _, mode := range []string{"normal", "simple-zero-balance", "unknown-run-mode", "lost-create", "failed-model", "cleanup-retry"} {
		t.Run(mode, func(t *testing.T) {
			var mu sync.Mutex
			creates, models, deletes := 0, 0, 0
			key := probeKey{}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				defer mu.Unlock()
				if r.URL.Path != "/v1/models" && r.Header.Get("Authorization") != "Bearer panel" {
					t.Error("missing panel authentication")
				}
				switch r.URL.Path {
				case "/api/v1/auth/me":
					switch mode {
					case "simple-zero-balance":
						reply(w, `{"code":0,"data":{"run_mode":"simple","balance":0}}`)
					case "unknown-run-mode":
						reply(w, `{"code":0,"data":{"balance":0}}`)
					default:
						reply(w, `{"code":0,"data":{"run_mode":"standard","balance":1}}`)
					}
				case "/api/v1/groups/available":
					reply(w, `{"code":0,"data":[{"id":1,"name":"public","rate_multiplier":1,"is_exclusive":false,"subscription_type":"standard"},{"id":2,"name":"private","is_exclusive":true,"subscription_type":"standard"}]}`)
				case "/api/v1/keys":
					if r.Method == "GET" {
						json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": map[string]any{"items": []probeKey{key}, "total": 1}})
						return
					}
					creates++
					var body struct {
						Name   string  `json:"name"`
						Group  int64   `json:"group_id"`
						Key    string  `json:"custom_key"`
						Quota  float64 `json:"quota"`
						Expiry int     `json:"expires_in_days"`
					}
					if json.NewDecoder(r.Body).Decode(&body) != nil || body.Group != 1 || body.Expiry != 1 || body.Quota <= 0 || r.Header.Get("Idempotency-Key") != body.Name {
						t.Error("unsafe probe key creation")
					}
					key = probeKey{ID: 99, GroupID: 1, Name: body.Name, Key: body.Key}
					if mode == "lost-create" {
						conn, _, _ := w.(http.Hijacker).Hijack()
						conn.Close()
						return
					}
					json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": key})
				case "/v1/models":
					models++
					if r.Header.Get("Authorization") != "Bearer "+key.Key || r.Header.Get("Cookie") != "" || r.Header.Get("New-Api-User") != "" {
						t.Error("panel credentials leaked to gateway")
					}
					if mode == "failed-model" {
						conn, _, _ := w.(http.Hijacker).Hijack()
						conn.Close()
						return
					}
					reply(w, `{"object":"list","data":[{"id":"z-model"},{"id":"a-model"},{"id":"z-model"}]}`)
				case "/api/v1/keys/99":
					if r.Method != "DELETE" {
						t.Error("unexpected key mutation")
					}
					deletes++
					if mode == "cleanup-retry" && deletes == 1 {
						w.WriteHeader(503)
						reply(w, `{"code":503}`)
						return
					}
					reply(w, `{"code":0,"data":{}}`)
				default:
					t.Errorf("unexpected endpoint: %s", r.URL.Path)
				}
			}))
			defer server.Close()
			path := filepath.Join(t.TempDir(), "probes.db")
			store, err := OpenStore(path)
			if err != nil {
				t.Fatal(err)
			}
			c := importCredentials(t, store, Credential{URL: server.URL, Type: "sub2api", Account: "user", Password: "password"})[0]
			for run := 0; run < 3; run++ {
				provider, _ := PublicProviders()["sub2api"](c, time.Second)
				p := provider.(*sub2API)
				p.store = store
				catalog, err := p.Fetch(context.Background(), &Session{AccessToken: "panel"})
				if err != nil || len(catalog.Groups) != 1 {
					t.Fatalf("fetch failed: %v", err)
				}
				g := catalog.Groups[0]
				if mode != "failed-model" && (!g.ModelsKnown || g.ModelsSource != "gateway_once" || len(g.Models) != 2 || g.Models[0] != "a-model" || g.ModelsFetchedAt == "") {
					t.Fatal("model snapshot missing or incorrect")
				}
				if mode == "failed-model" && (g.ModelsKnown || len(catalog.Warnings) == 0) {
					t.Fatal("failed discovery claimed to be known")
				}
				encoded, _ := json.Marshal(catalog)
				if strings.Contains(string(encoded), key.Key) {
					t.Fatal("probe key leaked")
				}
				if run == 0 {
					store.Close()
					store, err = OpenStore(path)
					if err != nil {
						t.Fatal(err)
					}
				}
			}
			defer store.Close()
			mu.Lock()
			defer mu.Unlock()
			wantDeletes := 1
			if mode == "cleanup-retry" {
				wantDeletes = 2
			}
			if creates != 1 || models != 1 || deletes != wantDeletes {
				t.Fatalf("repeated one-shot action: create=%d models=%d delete=%d", creates, models, deletes)
			}
			var state, secret string
			if err := store.db.QueryRow("SELECT state,key_secret FROM model_probes").Scan(&state, &secret); err != nil || state != "done" || secret != "" {
				t.Fatal("key was not cleaned up durably")
			}
		})
	}
}

func TestPublicModelDiscoveryWaitsForBalanceWithoutSpendingItsOneAttempt(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "balance.db")
	store, err := OpenStore(filename)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { store.Close() }()
	balance, creates, modelRequests, profiles := 0, 0, 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/api/v1/auth/me":
			profiles++
			reply(w, fmt.Sprintf(`{"code":0,"data":{"run_mode":"standard","balance":%d}}`, balance))
		case "/api/v1/keys":
			creates++
			var body struct {
				Name  string `json:"name"`
				Key   string `json:"custom_key"`
				Group int64  `json:"group_id"`
			}
			json.NewDecoder(request.Body).Decode(&body)
			json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": probeKey{ID: body.Group, GroupID: body.Group, Name: body.Name, Key: body.Key}})
		case "/v1/models":
			modelRequests++
			reply(w, `{"data":[{"id":"visible-model"}]}`)
		default:
			reply(w, `{"code":0,"data":{}}`)
		}
	}))
	defer server.Close()
	credential := importCredentials(t, store, Credential{URL: server.URL, Type: "sub2api", Account: "user", Password: "password"})[0]
	run := func() Catalog {
		provider, _ := PublicProviders()["sub2api"](credential, time.Second)
		probeProvider := provider.(*sub2API)
		probeProvider.store = store
		catalog := Catalog{Groups: []Group{{ID: "1", Name: "public"}}}
		if err := probeProvider.discoverModels(context.Background(), &Session{AccessToken: "panel"}, &catalog); err != nil {
			t.Fatal(err)
		}
		return catalog
	}
	for attempt := 0; attempt < 2; attempt++ {
		catalog := run()
		if creates != 0 || modelRequests != 0 || catalog.Groups[0].ModelsKnown || !strings.Contains(strings.Join(catalog.Warnings, " "), "balance") {
			t.Fatalf("zero balance consumed one-time discovery: creates=%d models=%d warnings=%v", creates, modelRequests, catalog.Warnings)
		}
		var probes int
		if err := store.db.QueryRow("SELECT count(*) FROM model_probes").Scan(&probes); err != nil || probes != 0 {
			t.Fatalf("deferred discovery was persisted as an attempt: %d %v", probes, err)
		}
		store.Close()
		store, err = OpenStore(filename)
		if err != nil {
			t.Fatal(err)
		}
	}
	balance = 1
	if catalog := run(); !catalog.Groups[0].ModelsKnown || creates != 1 || modelRequests != 1 {
		t.Fatal("funded account did not start its first discovery")
	}
	balance = 0
	previousProfiles := profiles
	if catalog := run(); !catalog.Groups[0].ModelsKnown || creates != 1 || modelRequests != 1 || profiles != previousProfiles {
		t.Fatal("cached successful discovery was retried or withheld")
	}
}

func TestGatewayModelFailuresRetainSafeReasonsAndNeverReplay(t *testing.T) {
	for _, entry := range []struct {
		name         string
		status       int
		body, reason string
	}{
		{"balance", 403, `{"code":"INSUFFICIENT_BALANCE","message":"private-token"}`, "INSUFFICIENT_BALANCE"},
		{"nested-quota", 429, `{"error":{"code":"insufficient_quota","message":"private-token"}}`, "insufficient_quota"},
		{"private-code", 403, `{"code":"private-token","message":"private-token"}`, "access_denied"},
		{"invalid-success", 200, `{"message":"private-token"}`, "invalid_response"},
	} {
		t.Run(entry.name, func(t *testing.T) {
			requests, deletes := 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				if request.URL.Path == "/v1/models" {
					requests++
					w.WriteHeader(entry.status)
					reply(w, entry.body)
					return
				}
				deletes++
				reply(w, `{"code":0,"data":{}}`)
			}))
			defer server.Close()
			store := testStore(t)
			credential := importCredentials(t, store, Credential{URL: server.URL, Type: "sub2api", Account: "u", Password: "p"})[0]
			provider, _ := NewSub2API(credential, time.Second)
			probeProvider := provider.(*sub2API)
			probeProvider.store = store
			source := fmt.Sprintf("%x", sha256.Sum256([]byte(credential.URL+"\x00"+credential.Account)))
			probe := &modelProbe{Source: source, GroupID: "1", State: "ready", Name: "probe", Secret: "private-key", KeyID: 1}
			if err := probeProvider.saveProbe(context.Background(), probe); err != nil {
				t.Fatal(err)
			}
			for attempt := 0; attempt < 2; attempt++ {
				catalog := Catalog{Groups: []Group{{ID: "1", Name: "public"}}}
				if err := probeProvider.discoverModels(context.Background(), &Session{AccessToken: "panel"}, &catalog); err != nil {
					t.Fatal(err)
				}
				warnings := strings.Join(catalog.Warnings, " ")
				if catalog.Groups[0].ModelsKnown || !strings.Contains(warnings, "("+entry.reason+"=1)") || strings.Contains(warnings, "private-token") {
					t.Fatalf("missing safe failure in catalog: %v", catalog.Warnings)
				}
			}
			var state, secret, failure string
			if err := store.db.QueryRow("SELECT state,key_secret,error FROM model_probes").Scan(&state, &secret, &failure); err != nil {
				t.Fatal(err)
			}
			if state != "done" || secret != "" || requests != 1 || deletes != 1 || !strings.Contains(failure, entry.reason) || strings.Contains(failure, "private-token") {
				t.Fatalf("missing safe failure or repeated attempt: reason=%q requests=%d deletes=%d", failure, requests, deletes)
			}
		})
	}
}

func TestInterruptedModelProbeDoesNotReplayFetch(t *testing.T) {
	store := testStore(t)
	deletes := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "DELETE" || r.URL.Path != "/api/v1/keys/7" {
			t.Error("interrupted probe was replayed")
		}
		deletes++
		reply(w, `{"code":0,"data":{}}`)
	}))
	defer server.Close()
	c := importCredentials(t, store, Credential{URL: server.URL, Type: "sub2api", Account: "u", Password: "p"})[0]
	provider, _ := NewSub2API(c, time.Second)
	p := provider.(*sub2API)
	p.store = store
	probe := &modelProbe{Source: "source", GroupID: "1", State: "fetching", Name: "probe", Secret: "key", KeyID: 7}
	if err := p.saveProbe(context.Background(), probe); err != nil {
		t.Fatal(err)
	}
	if err := p.resumeProbe(context.Background(), &Session{AccessToken: "panel"}, probe); err != nil || probe.State != "done" || probe.Models.Valid || deletes != 1 {
		t.Fatalf("unsafe recovery: %v", err)
	}
}

func TestModelProbeBatchLimit(t *testing.T) {
	t.Setenv("CERIUM_MODEL_PROBES_PER_RUN", "1")
	store := testStore(t)
	creates := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/keys":
			creates++
			var body struct {
				Name  string `json:"name"`
				Group int64  `json:"group_id"`
				Key   string `json:"custom_key"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": probeKey{ID: body.Group, GroupID: body.Group, Name: body.Name, Key: body.Key}})
		case "/v1/models":
			reply(w, `{"data":[]}`)
		default:
			reply(w, `{"code":0,"data":{}}`)
		}
	}))
	defer server.Close()
	c := importCredentials(t, store, Credential{URL: server.URL, Type: "sub2api", Account: "u", Password: "p"})[0]
	provider, _ := NewSub2API(c, time.Second)
	p := provider.(*sub2API)
	p.store = store
	for run := 1; run <= 3; run++ {
		catalog := Catalog{Groups: []Group{{ID: "1", Name: "one"}, {ID: "2", Name: "two"}}}
		if err := p.discoverModels(context.Background(), &Session{AccessToken: "panel"}, &catalog); err != nil {
			t.Fatal(err)
		}
		if creates != min(run, 2) {
			t.Fatal(fmt.Sprintf("batch limit or cache failed: %d", creates))
		}
	}
}
