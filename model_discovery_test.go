package cerium

import (
	"context"
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
	for _, mode := range []string{"normal", "lost-create", "failed-model", "cleanup-retry"} {
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
