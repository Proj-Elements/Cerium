package cerium

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestCredentialMutationsPreserveCrossConnectionActiveLease(t *testing.T) {
	for _, change := range []string{"remove", "import", "bridge-delete", "bridge-auth", "model-refresh"} {
		t.Run(change, func(t *testing.T) {
			filename := filepath.Join(t.TempDir(), "leased.db")
			worker, err := OpenStore(filename)
			if err != nil {
				t.Fatal(err)
			}
			defer worker.Close()
			credential := importCredentials(t, worker, Credential{Name: "Site", URL: "https://example.invalid", Type: "newapi", Account: "original", Password: "password"})[0]
			administrator, err := OpenStore(filename)
			if err != nil {
				t.Fatal(err)
			}
			defer administrator.Close()
			bridge, err := NewBridge(administrator, bridgeTestSecret, sinkFunc(func(context.Context, Result) error { return nil }))
			if err != nil {
				t.Fatal(err)
			}
			job := BridgeJob{JobID: "job-00000000000001", SiteID: "site-00000000000001", Revision: 2, Operation: "sync", Name: "Site", URL: credential.URL, Type: credential.Type, Account: credential.Account, Password: "changed"}
			if _, err := administrator.db.Exec("INSERT INTO bridge_sites VALUES(?,?,1)", job.SiteID, credential.ID); err != nil {
				t.Fatal(err)
			}
			entered, release := make(chan struct{}), make(chan struct{})
			var refreshes atomic.Int32
			provider := &stubProvider{refresh: func(context.Context, *Session) error {
				if refreshes.Add(1) == 1 {
					close(entered)
					<-release
				}
				return ErrRefreshUnsupported
			}}
			registry := Registry{"newapi": func(Credential, time.Duration) (Provider, error) { return provider, nil }}
			finished := make(chan error, 1)
			go func() {
				_, err := (&Syncer{Store: worker, Providers: registry}).Run(context.Background())
				finished <- err
			}()
			defer func() {
				close(release)
				if err := <-finished; err != nil {
					t.Errorf("original synchronization was invalidated: %v", err)
				}
			}()
			select {
			case <-entered:
			case <-time.After(3 * time.Second):
				t.Fatal("first synchronization did not start")
			}
			switch change {
			case "remove":
				err = administrator.Remove(context.Background(), credential.ID)
			case "import":
				_, err = administrator.Import(context.Background(), strings.NewReader(`{"credentials":[{"url":"https://example.invalid","type":"newapi","account":"original","password":"changed"}]}`))
			case "model-refresh":
				err = administrator.RefreshModelProbesForJob(context.Background(), credential.ID, job.JobID)
			default:
				if change == "bridge-delete" {
					job.Operation = "delete"
				}
				_, err = bridge.configure(context.Background(), job)
			}
			if !errors.Is(err, errSynchronizationBusy) {
				t.Fatalf("mutation bypassed the active lease: %v", err)
			}
			credentials, err := administrator.Credentials(context.Background())
			if err != nil || len(credentials) != 1 || credentials[0].ID != credential.ID || credentials[0].Password != credential.Password {
				t.Fatal("rejected mutation changed credentials", err)
			}
			if _, err := (&Syncer{Store: administrator, Providers: registry}).Run(context.Background()); !errors.Is(err, errSynchronizationBusy) {
				t.Fatalf("another synchronization entered the leased credential: %v", err)
			}
			if refreshes.Load() != 1 {
				t.Fatal("token refresh overlapped an active synchronization")
			}
		})
	}
}

func TestStaleCredentialDoesNotStartProviderAfterAuthenticationChange(t *testing.T) {
	store := testStore(t)
	credential := importCredentials(t, store, testCredential())[0]
	changed := credential
	changed.Password = "changed"
	importCredentials(t, store, changed)
	var requests atomic.Int32
	provider := &stubProvider{login: func(context.Context, *Session) error { requests.Add(1); return nil }}
	_, err := (&Syncer{Store: store}).syncOne(context.Background(), credential, registryFor(provider), time.Second, time.Second)
	if !errors.Is(err, ErrCredentialChanged) || requests.Load() != 0 {
		t.Fatal("stale credentials reached the provider", err, requests.Load())
	}
	var leases int
	if err := store.db.QueryRow("SELECT COUNT(*) FROM leases").Scan(&leases); err != nil || leases != 0 {
		t.Fatal("stale credentials acquired a lease", leases, err)
	}
}

func TestCosmeticCredentialEditsKeepActiveLeaseAndExpiredLeaseAllowsRemoval(t *testing.T) {
	store := testStore(t)
	credential := importCredentials(t, store, Credential{Name: "Site", URL: "https://example.invalid", Type: "newapi", Account: "original", Password: "password"})[0]
	if acquired, err := store.acquire(context.Background(), credential.ID, "active", time.Now().Add(time.Minute)); err != nil || !acquired {
		t.Fatal("could not seed active lease", err)
	}
	changed := credential
	changed.Name = "Renamed"
	updated := importCredentials(t, store, changed)[0]
	if updated.Revision != credential.Revision || updated.Name != changed.Name {
		t.Fatal("cosmetic import changed authentication revision")
	}
	bridge, err := NewBridge(store, bridgeTestSecret, sinkFunc(func(context.Context, Result) error { return nil }))
	if err != nil {
		t.Fatal(err)
	}
	job := BridgeJob{JobID: "job-00000000000001", SiteID: "site-00000000000001", Revision: 2, Operation: "sync", Name: "Again", URL: credential.URL, Type: credential.Type, Account: credential.Account, Password: credential.Password}
	if _, err := store.db.Exec("INSERT INTO bridge_sites VALUES(?,?,1)", job.SiteID, credential.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := bridge.configure(context.Background(), job); err != nil {
		t.Fatal("cosmetic bridge edit blocked on lease", err)
	}
	var owner string
	if err := store.db.QueryRow("SELECT owner FROM leases WHERE credential_id=?", credential.ID).Scan(&owner); err != nil || owner != "active" {
		t.Fatal("cosmetic edit changed lease", err)
	}
	job.Operation = "delete"
	if response := postBridgeJob(t, bridge, job); response.Code != 503 {
		t.Fatal("leased deletion did not produce a retryable response", response.Code, response.Body.String())
	}
	if _, err := store.db.Exec("UPDATE leases SET expires_at=? WHERE credential_id=?", time.Now().Add(-time.Minute).Unix(), credential.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.Remove(context.Background(), credential.ID); err != nil {
		t.Fatal("expired lease blocked removal", err)
	}
}
