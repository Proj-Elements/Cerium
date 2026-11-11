package cerium

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"
)

func cleanupTestStore(t *testing.T, filename string) *Store {
	t.Helper()
	store, err := OpenStore(filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(probeCleanupSchema); err != nil {
		store.Close()
		t.Fatal(err)
	}
	return store
}

func TestDeletedCredentialRetainsCleanupAcrossRestart(t *testing.T) {
	for _, state := range []string{"creating", "ready", "fetching", "cleanup"} {
		t.Run(state, func(t *testing.T) {
			deletes := 0
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				if request.Header.Get("Authorization") != "Bearer panel" {
					t.Error("cleanup lost the original panel session")
				}
				switch {
				case request.Method == http.MethodGet && request.URL.Path == "/api/v1/keys":
					reply(w, `{"code":0,"data":{"items":[{"id":9,"group_id":1,"name":"probe-original"}],"total":1}}`)
				case request.Method == http.MethodDelete && request.URL.Path == "/api/v1/keys/9":
					deletes++
					reply(w, `{"code":0,"data":{}}`)
				default:
					t.Errorf("cleanup repeated a one-time action: %s %s", request.Method, request.URL.Path)
					w.WriteHeader(http.StatusBadRequest)
				}
			}))
			defer upstream.Close()
			filename := filepath.Join(t.TempDir(), "cleanup.db")
			store := cleanupTestStore(t, filename)
			credential := importCredentials(t, store, Credential{URL: upstream.URL, Type: "sub2api", Account: "u", Password: "p"})[0]
			if err := store.SaveSession(context.Background(), credential, Session{AccessToken: "panel"}); err != nil {
				t.Fatal(err)
			}
			provider, _ := NewSub2API(credential, time.Second)
			probeProvider := provider.(*sub2API)
			probeProvider.store = store
			keyID := int64(9)
			if state == "creating" {
				keyID = 0
			}
			if err := probeProvider.saveProbe(context.Background(), &modelProbe{Source: "source", GroupID: "1", State: state, Name: "probe-original", Secret: "temporary-secret", KeyID: keyID}); err != nil {
				t.Fatal(err)
			}
			transaction, err := store.db.Begin()
			if err != nil {
				t.Fatal(err)
			}
			if err := retainProbeCleanup(context.Background(), transaction, credential.ID); err != nil {
				t.Fatal(err)
			}
			if _, err := transaction.Exec("DELETE FROM credentials WHERE id=?", credential.ID); err != nil {
				t.Fatal(err)
			}
			if err := transaction.Commit(); err != nil {
				t.Fatal(err)
			}
			store.Close()
			store = cleanupTestStore(t, filename)
			defer store.Close()
			if err := store.RetryProbeCleanup(context.Background()); err != nil {
				t.Fatal(err)
			}
			if err := store.RetryProbeCleanup(context.Background()); err != nil {
				t.Fatal(err)
			}
			var remaining int
			store.db.QueryRow("SELECT count(*) FROM model_probe_cleanup").Scan(&remaining)
			if deletes != 1 || remaining != 0 {
				t.Fatalf("cleanup was lost or replayed: deletes=%d remaining=%d", deletes, remaining)
			}
		})
	}
}

func TestFailedCleanupDoesNotBlockOtherGroups(t *testing.T) {
	store := cleanupTestStore(t, filepath.Join(t.TempDir(), "groups.db"))
	defer store.Close()
	creates, modelRequests := 0, 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/api/v1/keys/9":
			w.WriteHeader(http.StatusForbidden)
			reply(w, `{"code":403}`)
		case "/api/v1/keys":
			var body struct {
				Name  string `json:"name"`
				Group int64  `json:"group_id"`
				Key   string `json:"custom_key"`
			}
			json.NewDecoder(request.Body).Decode(&body)
			creates++
			json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": probeKey{ID: body.Group, GroupID: body.Group, Name: body.Name, Key: body.Key}})
		case "/v1/models":
			modelRequests++
			reply(w, `{"data":[{"id":"available-model"}]}`)
		default:
			reply(w, `{"code":0,"data":{}}`)
		}
	}))
	defer upstream.Close()
	credential := importCredentials(t, store, Credential{URL: upstream.URL, Type: "sub2api", Account: "u", Password: "p"})[0]
	provider, _ := NewSub2API(credential, time.Second)
	probeProvider := provider.(*sub2API)
	probeProvider.store = store
	source := fmt.Sprintf("%x", sha256.Sum256([]byte(credential.URL+"\x00"+credential.Account)))
	if err := probeProvider.saveProbe(context.Background(), &modelProbe{Source: source, GroupID: "1", State: "cleanup", Name: "blocked", KeyID: 9}); err != nil {
		t.Fatal(err)
	}
	catalog := Catalog{Groups: []Group{{ID: "1", Name: "blocked"}, {ID: "2", Name: "unrelated"}}}
	if err := probeProvider.discoverModels(context.Background(), &Session{AccessToken: "panel"}, &catalog); err != nil {
		t.Fatal(err)
	}
	if creates != 1 || modelRequests != 1 || !catalog.Groups[1].ModelsKnown {
		t.Fatalf("failed cleanup blocked another group: creates=%d requests=%d catalog=%+v", creates, modelRequests, catalog)
	}
}

func TestExplicitProbeRefreshRequiresCompletedCleanup(t *testing.T) {
	store := cleanupTestStore(t, filepath.Join(t.TempDir(), "refresh.db"))
	defer store.Close()
	credential := importCredentials(t, store, Credential{URL: "https://example.com", Type: "sub2api", Account: "u", Password: "p"})[0]
	provider, _ := NewSub2API(credential, time.Second)
	probeProvider := provider.(*sub2API)
	probeProvider.store = store
	probe := &modelProbe{Source: "source", GroupID: "1", State: "cleanup", Name: "pending", KeyID: 9, Models: sql.NullString{String: `["cached-model"]`, Valid: true}}
	if err := probeProvider.saveProbe(context.Background(), probe); err != nil {
		t.Fatal(err)
	}
	if err := store.RefreshModelProbes(context.Background(), credential.ID); err == nil {
		t.Fatal("refresh discarded pending key cleanup")
	}
	probe.State = "done"
	if err := probeProvider.saveProbe(context.Background(), probe); err != nil {
		t.Fatal(err)
	}
	if err := store.RefreshModelProbes(context.Background(), credential.ID); err != nil {
		t.Fatal(err)
	}
	var remaining int
	store.db.QueryRow("SELECT count(*) FROM model_probes WHERE credential_id=?", credential.ID).Scan(&remaining)
	if remaining != 0 {
		t.Fatal("explicit refresh retained completed discovery")
	}
}

func TestModelRefreshJobDoesNotResetNewlyCompletedProbe(t *testing.T) {
	store := cleanupTestStore(t, filepath.Join(t.TempDir(), "refresh-idempotency.db"))
	defer store.Close()
	credential := importCredentials(t, store, Credential{URL: "https://example.com", Type: "sub2api", Account: "u", Password: "p"})[0]
	if err := store.RefreshModelProbesForJob(context.Background(), credential.ID, "refresh-job"); err != nil {
		t.Fatal(err)
	}
	provider, _ := NewSub2API(credential, time.Second)
	probeProvider := provider.(*sub2API)
	probeProvider.store = store
	if err := probeProvider.saveProbe(context.Background(), &modelProbe{Source: "source", GroupID: "1", State: "done", Name: "new-probe", Models: sql.NullString{String: `[]`, Valid: true}}); err != nil {
		t.Fatal(err)
	}
	if err := store.RefreshModelProbesForJob(context.Background(), credential.ID, "refresh-job"); err != nil {
		t.Fatal(err)
	}
	var remaining int
	store.db.QueryRow("SELECT count(*) FROM model_probes WHERE credential_id=?", credential.ID).Scan(&remaining)
	if remaining != 1 {
		t.Fatal("retry of the same refresh job discarded its completed discovery")
	}
}

func TestRetainedCleanupBlocksOnlyItsOwnGroupAndSurvivesFailure(t *testing.T) {
	store := cleanupTestStore(t, filepath.Join(t.TempDir(), "retained.db"))
	defer store.Close()
	creates := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/api/v1/keys/9":
			w.WriteHeader(http.StatusForbidden)
			reply(w, `{"code":403}`)
		case "/api/v1/keys":
			var body struct {
				Name  string `json:"name"`
				Group int64  `json:"group_id"`
				Key   string `json:"custom_key"`
			}
			json.NewDecoder(request.Body).Decode(&body)
			if body.Group != 2 {
				t.Error("unresolved key created again")
			}
			creates++
			json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": probeKey{ID: body.Group, GroupID: body.Group, Name: body.Name, Key: body.Key}})
		case "/v1/models":
			reply(w, `{"data":[]}`)
		default:
			reply(w, `{"code":0,"data":{}}`)
		}
	}))
	defer upstream.Close()
	credential := importCredentials(t, store, Credential{URL: upstream.URL, Type: "sub2api", Account: "u", Password: "p"})[0]
	store.SaveSession(context.Background(), credential, Session{AccessToken: "panel"})
	provider, _ := NewSub2API(credential, time.Second)
	probeProvider := provider.(*sub2API)
	probeProvider.store = store
	source := fmt.Sprintf("%x", sha256.Sum256([]byte(credential.URL+"\x00"+credential.Account)))
	probeProvider.saveProbe(context.Background(), &modelProbe{Source: source, GroupID: "1", State: "cleanup", Name: "pending", KeyID: 9})
	transaction, err := store.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err := retainProbeCleanup(context.Background(), transaction, credential.ID); err != nil {
		t.Fatal(err)
	}
	if err := transaction.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := store.RetryProbeCleanup(context.Background()); err == nil {
		t.Fatal("cleanup failure was reported as successful")
	}
	if err := store.RefreshModelProbesForJob(context.Background(), credential.ID, "refresh-pending"); err == nil {
		t.Fatal("explicit refresh discarded a retained cleanup")
	}
	catalog := Catalog{Groups: []Group{{ID: "1", Name: "blocked"}, {ID: "2", Name: "unrelated"}}}
	if err := probeProvider.discoverModels(context.Background(), &Session{AccessToken: "panel"}, &catalog); err != nil {
		t.Fatal(err)
	}
	var attempts, nextAttempt int64
	if err := store.db.QueryRow("SELECT attempts,next_attempt_at FROM model_probe_cleanup WHERE key_name='pending'").Scan(&attempts, &nextAttempt); err != nil {
		t.Fatal(err)
	}
	if creates != 1 || catalog.Groups[0].ModelsKnown || !catalog.Groups[1].ModelsKnown || attempts != 1 || nextAttempt <= time.Now().Unix() {
		t.Fatalf("failed cleanup was lost or blocked unrelated discovery: creates=%d attempts=%d", creates, attempts)
	}
}
