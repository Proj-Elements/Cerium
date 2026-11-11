package cerium

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testStore(t *testing.T) *Store {
	t.Helper()
	store, err := OpenStore(filepath.Join(t.TempDir(), "private & data", "cerium?.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func importCredentials(t *testing.T, store *Store, credentials ...Credential) []Credential {
	t.Helper()
	rows := make([]map[string]any, 0, len(credentials))
	for _, c := range credentials {
		rows = append(rows, map[string]any{"name": c.Name, "url": c.URL, "type": c.Type, "account": c.Account, "password": c.Password, "access_token": c.AccessToken, "user_id": c.UserID})
	}
	data, err := json.Marshal(map[string]any{"credentials": rows})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Import(context.Background(), bytes.NewReader(data)); err != nil {
		t.Fatal(err)
	}
	out, err := store.Credentials(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func testCredential() Credential {
	return Credential{Name: "test site", URL: "https://example.invalid", Type: "test", Account: "user@example.com", Password: "private-password"}
}

func TestStoreRoundTripAndCredentialChanges(t *testing.T) {
	ctx := context.Background()
	store := testStore(t)
	input := testCredential()
	input.URL += "/"
	input.Password = "  preserve password whitespace  "
	c := importCredentials(t, store, input)[0]
	if c.URL != "https://example.invalid" || c.Password != input.Password || c.Revision != 1 {
		t.Fatalf("unexpected normalized credential: %#v", c.ID)
	}
	session := Session{AccessToken: "private-at", RefreshToken: "private-rt", UserID: 7, SessionID: "sid", ExpiresAt: time.Now().UTC().Truncate(time.Second), Cookies: []*http.Cookie{{Name: "session", Value: "private-cookie", Path: "/"}}}
	if err := store.SaveSession(ctx, c, session); err != nil {
		t.Fatal(err)
	}
	result := Result{CredentialID: c.ID, CheckedAt: time.Now().UTC(), Catalog: &Catalog{Groups: []Group{{ID: "g", Name: "group"}}}}
	if err := store.SaveResult(ctx, c, result); err != nil {
		t.Fatal(err)
	}
	got, err := store.Session(ctx, c.ID)
	if err != nil || !reflect.DeepEqual(got, session) {
		t.Fatalf("session round trip failed: %v", err)
	}
	input.Name = "renamed site"
	c2 := importCredentials(t, store, input)[0]
	if c2.ID != c.ID || c2.Revision != c.Revision || c2.Name != input.Name {
		t.Fatal("identical import did not preserve identity/revision")
	}
	got, err = store.Session(ctx, c.ID)
	if err != nil || got.RefreshToken != session.RefreshToken {
		t.Fatal("identical import discarded the session")
	}
	sites, err := store.Sites(ctx)
	if err != nil || sites[0].Snapshot == nil {
		t.Fatal("snapshot was not preserved")
	}
	encoded, err := json.Marshal(sites)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{input.Password, session.AccessToken, session.RefreshToken, "private-cookie"} {
		if bytes.Contains(encoded, []byte(secret)) {
			t.Fatal("public site output contains a secret")
		}
	}
	input.Password = "changed-password"
	c3 := importCredentials(t, store, input)[0]
	if c3.ID != c.ID || c3.Revision != c.Revision+1 {
		t.Fatal("password change did not increment the revision")
	}
	got, err = store.Session(ctx, c.ID)
	if err != nil || !got.Empty() {
		t.Fatal("password change did not invalidate the session")
	}
	sites, err = store.Sites(ctx)
	if err != nil || sites[0].Snapshot != nil || sites[0].LastRun != nil {
		t.Fatal("password change did not invalidate the snapshot")
	}
	if err := store.SaveSession(ctx, c, session); !errors.Is(err, ErrCredentialChanged) {
		t.Fatalf("stale session accepted: %v", err)
	}
	if err := store.SaveResult(ctx, c, result); !errors.Is(err, ErrCredentialChanged) {
		t.Fatalf("stale result accepted: %v", err)
	}
	if err := store.SaveSession(ctx, c3, session); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveResult(ctx, c3, result); err != nil {
		t.Fatal(err)
	}
	if ok, err := store.acquire(ctx, c.ID, "owner", time.Now().Add(time.Minute)); err != nil || !ok {
		t.Fatalf("acquire: %v", err)
	}
	if err := store.Remove(ctx, c.ID); !errors.Is(err, errSynchronizationBusy) {
		t.Fatalf("active lease was not protected: %v", err)
	}
	if err := store.release(ctx, c.ID, "owner"); err != nil {
		t.Fatal(err)
	}
	if err := store.Remove(ctx, c.ID); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"credentials", "sessions", "snapshots", "leases"} {
		var count int
		if err := store.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+table).Scan(&count); err != nil || count != 0 {
			t.Fatalf("cascade delete failed for %s: count=%d, error=%v", table, count, err)
		}
	}
	if err := store.Remove(ctx, c.ID); err == nil {
		t.Fatal("removing a nonexistent credential succeeded")
	}
	replacement := importCredentials(t, store, testCredential())[0]
	if replacement.ID <= c.ID {
		t.Fatal("a deleted credential ID was reused")
	}
	if err := store.SaveSession(ctx, c, session); !errors.Is(err, ErrCredentialChanged) {
		t.Fatal("an old worker could write into a replacement credential")
	}
}

func TestStorePrivateFileAndReopen(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "nested", "data.db")
	for i := range 2 {
		store, err := OpenStore(filename)
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			c := importCredentials(t, store, testCredential())[0]
			if err := store.SaveSession(context.Background(), c, Session{AccessToken: "persisted"}); err != nil {
				t.Fatal(err)
			}
		} else {
			session, err := store.Session(context.Background(), 1)
			if err != nil || session.AccessToken != "persisted" {
				t.Fatalf("persisted session lost on reopen: %v", err)
			}
		}
		if err := store.Close(); err != nil {
			t.Fatal(err)
		}
	}
	info, err := os.Stat(filename)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("database is not private: %v", err)
	}
	info, err = os.Stat(filepath.Dir(filename))
	if err != nil || info.Mode().Perm() != 0700 {
		t.Fatalf("new data directory is not private: %v", err)
	}
}

func TestImportValidationIsAtomic(t *testing.T) {
	store := testStore(t)
	ctx := context.Background()
	importCredentials(t, store, testCredential())
	for _, config := range []string{
		`{}`, `{"credentials":[]}`, `{"credentials":[{"url":"https://x.invalid","type":"test","account":"u"}]}`,
		`{"credentials":[{"url":"https://u:password@x.invalid","type":"test","account":"u","password":"p"}]}`,
		`{"credentials":[{"url":"https://x.invalid?secret=p","type":"test","account":"u","password":"p"}]}`,
		`{"credentials":[{"url":"https://x.invalid","type":"test","account":"u","password":"p","unknown":"secret"}]}`,
		`{"credentials":[{"url":"https://x.invalid","type":"test","account":"u","password":"p"}]} {}`,
		`{"credentials":[{"url":"https://x.invalid","type":"test","account":"u","password":"p"},{"url":"https://x.invalid/","type":"test","account":"u","password":"p"}]}`,
		`{"credentials":[{"url":"https://example.invalid","type":"test","account":"user@example.com","password":"changed"},{"url":"file:///invalid","type":"test","account":"u","password":"p"}]}`,
	} {
		if _, err := store.Import(ctx, strings.NewReader(config)); err == nil {
			t.Errorf("invalid configuration accepted: %s", config)
		}
	}
	credentials, err := store.Credentials(ctx)
	if err != nil || len(credentials) != 1 || credentials[0].Password != testCredential().Password {
		t.Fatal("invalid import partially changed the database")
	}
	t.Setenv("CERIUM_TEST_PASSWORD", "env-password")
	config := `{"credentials":[{"url":"https://env.invalid","type":"new-api","account":"u","password_env":"CERIUM_TEST_PASSWORD"}]}`
	if _, err := store.Import(ctx, strings.NewReader(config)); err != nil {
		t.Fatal(err)
	}
	credentials, err = store.Credentials(ctx)
	if err != nil || credentials[1].Type != "newapi" || credentials[1].Password != "env-password" {
		t.Fatal("password_env or provider alias failed")
	}
}

type stubProvider struct {
	login   func(context.Context, *Session) error
	refresh func(context.Context, *Session) error
	fetch   func(context.Context, *Session) (Catalog, error)
}

func (p *stubProvider) Login(ctx context.Context, s *Session) error {
	if p.login != nil {
		return p.login(ctx, s)
	}
	s.AccessToken = "logged-in"
	return nil
}

func (p *stubProvider) Refresh(ctx context.Context, s *Session) error {
	if p.refresh != nil {
		return p.refresh(ctx, s)
	}
	return ErrRefreshUnsupported
}

func (p *stubProvider) Fetch(ctx context.Context, s *Session) (Catalog, error) {
	if p.fetch != nil {
		return p.fetch(ctx, s)
	}
	return Catalog{Groups: []Group{{ID: "g", Name: "group"}}}, nil
}

func registryFor(p Provider) Registry {
	return Registry{"test": func(Credential, time.Duration) (Provider, error) { return p, nil }}
}

func TestRotatedTokensSurviveCancellationAndFetchFailure(t *testing.T) {
	store := testStore(t)
	c := importCredentials(t, store, testCredential())[0]
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p := &stubProvider{
		refresh: func(_ context.Context, s *Session) error {
			s.AccessToken, s.RefreshToken = "rotated-at", "rotated-rt"
			cancel()
			return nil
		},
		fetch: func(ctx context.Context, _ *Session) (Catalog, error) { return Catalog{}, ctx.Err() },
	}
	results, err := (&Syncer{Store: store, Providers: registryFor(p)}).Run(ctx)
	if err == nil || len(results) != 1 || results[0].Refresh != "rotated" || results[0].Error == "" {
		t.Fatalf("expected a cancelled fetch: %v", err)
	}
	session, err := store.Session(context.Background(), c.ID)
	if err != nil || session.AccessToken != "rotated-at" || session.RefreshToken != "rotated-rt" {
		t.Fatalf("rotated tokens were lost on cancellation: %v", err)
	}
	sites, err := store.Sites(context.Background())
	if err != nil || sites[0].LastRun == nil || sites[0].LastRun.Error == "" {
		t.Fatal("cancelled attempt was not persisted")
	}
}

func TestAuthenticationRecoveryIsBounded(t *testing.T) {
	for _, tc := range []struct {
		name       string
		refreshErr error
		fetchErr   error
		wantLogin  int
		wantFetch  int
		wantError  bool
	}{
		{"transient refresh retains AT", &APIError{Status: 503, Code: "503"}, nil, 0, 1, false},
		{"rejected refresh logs in once", &APIError{Status: 401, Code: "401"}, nil, 1, 1, false},
		{"legacy expired session logs in once", ErrRefreshUnsupported, &APIError{Status: 401, Code: "401"}, 1, 2, true},
		{"no login loop after refresh rejection", &APIError{Status: 401, Code: "401"}, &APIError{Status: 401, Code: "401"}, 1, 1, true},
		{"permission errors do not trigger login", ErrRefreshUnsupported, &APIError{Status: 403, Code: "403"}, 0, 1, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := testStore(t)
			c := importCredentials(t, store, testCredential())[0]
			if err := store.SaveSession(context.Background(), c, Session{AccessToken: "existing"}); err != nil {
				t.Fatal(err)
			}
			var logins, refreshes, fetches int
			p := &stubProvider{
				login:   func(_ context.Context, s *Session) error { logins++; s.AccessToken = "new"; return nil },
				refresh: func(context.Context, *Session) error { refreshes++; return tc.refreshErr },
				fetch: func(context.Context, *Session) (Catalog, error) {
					fetches++
					return Catalog{}, tc.fetchErr
				},
			}
			_, err := (&Syncer{Store: store, Providers: registryFor(p)}).Run(context.Background())
			if (err != nil) != tc.wantError || logins != tc.wantLogin || refreshes != 1 || fetches != tc.wantFetch {
				t.Fatalf("login=%d refresh=%d fetch=%d error=%v", logins, refreshes, fetches, err)
			}
		})
	}
}

func TestFailedSiteDoesNotStopOtherCredentials(t *testing.T) {
	store := testStore(t)
	bad, good := testCredential(), testCredential()
	bad.Account, good.Account = "bad", "good"
	importCredentials(t, store, bad, good)
	var successful atomic.Int32
	registry := Registry{"test": func(c Credential, _ time.Duration) (Provider, error) {
		return &stubProvider{login: func(_ context.Context, s *Session) error {
			if c.Account == "bad" {
				return errors.New("site unavailable")
			}
			s.AccessToken = "good-at"
			successful.Add(1)
			return nil
		}}, nil
	}}
	results, err := (&Syncer{Store: store, Providers: registry}).Run(context.Background())
	if err == nil || len(results) != 2 || results[0].Error == "" || results[1].Error != "" || successful.Load() != 1 {
		t.Fatalf("partial synchronization failed: %v", err)
	}
}

func TestConcurrentRunDoesNotReuseRefreshToken(t *testing.T) {
	store := testStore(t)
	importCredentials(t, store, testCredential())
	started, finish := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	p := &stubProvider{refresh: func(context.Context, *Session) error {
		calls.Add(1)
		close(started)
		<-finish
		return nil
	}}
	syncer := &Syncer{Store: store, Providers: registryFor(p)}
	done := make(chan error, 1)
	go func() { _, err := syncer.Run(context.Background()); done <- err }()
	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("first run did not reach refresh")
	}
	results, err := syncer.Run(context.Background())
	close(finish)
	if err == nil || len(results) != 1 || !strings.Contains(results[0].Error, "another synchronization") {
		t.Fatal("overlapping synchronization was not rejected")
	}
	if err := <-done; err != nil || calls.Load() != 1 {
		t.Fatalf("first run failed or refresh was duplicated: %v", err)
	}
	sites, err := store.Sites(context.Background())
	if err != nil || sites[0].LastRun.Error != "" {
		t.Fatal("rejected overlapping run replaced the completed run's snapshot")
	}
}

func TestExpiredLeaseCanBeReclaimed(t *testing.T) {
	store := testStore(t)
	c := importCredentials(t, store, testCredential())[0]
	ctx := context.Background()
	for _, lease := range []struct {
		owner string
		until time.Time
		want  bool
	}{{"crashed", time.Now().Add(-time.Minute), true}, {"new", time.Now().Add(time.Minute), true}, {"other", time.Now().Add(time.Minute), false}} {
		ok, err := store.acquire(ctx, c.ID, lease.owner, lease.until)
		if err != nil || ok != lease.want {
			t.Fatalf("lease %s: acquired=%v error=%v", lease.owner, ok, err)
		}
	}
	if err := store.release(ctx, c.ID, "crashed"); err != nil {
		t.Fatal(err)
	}
	if ok, err := store.acquire(ctx, c.ID, "other", time.Now().Add(time.Minute)); err != nil || ok {
		t.Fatal("old owner released the new owner's lease")
	}
}

func TestCatalogNormalization(t *testing.T) {
	zero := 0.0
	catalog := Catalog{Groups: []Group{{ID: "b", Name: "beta", Multiplier: &zero, ModelsKnown: true}, {ID: "a", Name: "alpha", Models: []string{"z", "", "a", "a"}, ModelsKnown: true}}}
	if err := normalizeCatalog(&catalog); err != nil {
		t.Fatal(err)
	}
	if catalog.Groups[0].ID != "a" || !reflect.DeepEqual(catalog.Groups[0].Models, []string{"a", "z"}) || catalog.Groups[1].Models == nil || *catalog.Groups[1].Multiplier != 0 {
		t.Fatalf("unexpected normalized catalog: %+v", catalog)
	}
	negative := -1.0
	for _, groups := range [][]Group{
		{{ID: "a", Name: "a"}, {ID: "a", Name: "duplicate"}},
		{{ID: "", Name: "a"}},
		{{ID: "a", Name: "a", Multiplier: &negative}},
	} {
		if err := normalizeCatalog(&Catalog{Groups: groups}); err == nil {
			t.Errorf("invalid groups accepted: %s", fmt.Sprint(groups))
		}
	}
}
