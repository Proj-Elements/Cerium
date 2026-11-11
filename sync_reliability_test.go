package cerium

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestSyncerBoundsConcurrencyAndRetainsCredentialOrder(t *testing.T) {
	store := testStore(t)
	var inputs []Credential
	for _, account := range []string{"one", "two", "three", "four"} {
		credential := testCredential()
		credential.Account = account
		inputs = append(inputs, credential)
	}
	credentials := importCredentials(t, store, inputs...)
	started := make(chan int64, len(credentials))
	release := make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	var active, maximum atomic.Int32
	registry := Registry{"test": func(credential Credential, _ time.Duration) (Provider, error) {
		return &stubProvider{fetch: func(ctx context.Context, _ *Session) (Catalog, error) {
			count := active.Add(1)
			defer active.Add(-1)
			for previous := maximum.Load(); count > previous; previous = maximum.Load() {
				if maximum.CompareAndSwap(previous, count) {
					break
				}
			}
			started <- credential.ID
			select {
			case <-release:
				return Catalog{Groups: []Group{}}, nil
			case <-ctx.Done():
				return Catalog{}, ctx.Err()
			}
		}}, nil
	}}
	var delivered []int64
	syncer := Syncer{Store: store, Providers: registry, MaxConcurrency: 2, Sinks: []Sink{sinkFunc(func(_ context.Context, result Result) error {
		delivered = append(delivered, result.CredentialID)
		return nil
	})}}
	type outcome struct {
		results []Result
		err     error
	}
	done := make(chan outcome, 1)
	go func() {
		results, err := syncer.Run(context.Background())
		done <- outcome{results: results, err: err}
	}()
	for range 2 {
		select {
		case <-started:
		case <-time.After(5 * time.Second):
			t.Fatal("independent credentials did not run concurrently")
		}
	}
	select {
	case <-started:
		t.Fatal("worker limit was exceeded before either worker finished")
	default:
	}
	close(release)
	select {
	case got := <-done:
		if got.err != nil || len(got.results) != len(credentials) || maximum.Load() != 2 {
			t.Fatalf("bounded run failed: max=%d results=%d error=%v", maximum.Load(), len(got.results), got.err)
		}
		var expected []int64
		for index, credential := range credentials {
			expected = append(expected, credential.ID)
			if got.results[index].CredentialID != credential.ID {
				t.Fatal("concurrent completion changed result ordering")
			}
		}
		if !reflect.DeepEqual(delivered, expected) {
			t.Fatal("sink delivery did not retain deterministic credential order")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("workers did not finish")
	}
}

func TestSyncerPersistsSafeErrorDiagnostics(t *testing.T) {
	for _, test := range []struct {
		name     string
		provider *stubProvider
		stage    string
		category string
	}{
		{"login rejected", &stubProvider{login: func(context.Context, *Session) error {
			return &APIError{Method: "POST", Path: "/login", Status: 401, Code: "401"}
		}}, "login", "authentication"},
		{"fetch failed", &stubProvider{fetch: func(context.Context, *Session) (Catalog, error) {
			return Catalog{}, &APIError{Method: "GET", Path: "/groups", Status: 503, Code: "503"}
		}}, "fetch_catalog", "upstream_http"},
		{"fetch timed out", &stubProvider{fetch: func(context.Context, *Session) (Catalog, error) {
			return Catalog{}, context.DeadlineExceeded
		}}, "fetch_catalog", "timeout"},
		{"catalog invalid", &stubProvider{fetch: func(context.Context, *Session) (Catalog, error) {
			return Catalog{Groups: []Group{{ID: "duplicate", Name: "one"}, {ID: "duplicate", Name: "two"}}}, nil
		}}, "validate_catalog", "invalid_response"},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := testStore(t)
			importCredentials(t, store, testCredential())
			results, err := (&Syncer{Store: store, Providers: registryFor(test.provider)}).Run(context.Background())
			if err == nil || len(results) != 1 || results[0].ErrorStage != test.stage || results[0].ErrorCategory != test.category || results[0].Error == "" {
				t.Fatalf("missing useful error diagnostics: results=%+v error=%v", results, err)
			}
			sites, err := store.Sites(context.Background())
			if err != nil || len(sites) != 1 || sites[0].LastRun.ErrorStage != test.stage || sites[0].LastRun.ErrorCategory != test.category {
				t.Fatalf("diagnostics were not persisted: %v", err)
			}
		})
	}
}

func TestSyncerCanceledRunDoesNotStartCredentials(t *testing.T) {
	store := testStore(t)
	importCredentials(t, store, testCredential())
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	results, err := (&Syncer{Store: store, Providers: registryFor(&stubProvider{})}).Run(ctx)
	if !errors.Is(err, context.Canceled) || len(results) != 0 {
		t.Fatalf("canceled synchronization unexpectedly ran: results=%d error=%v", len(results), err)
	}
}

func TestBaseURLCanonicalizesEveryTrailingSlash(t *testing.T) {
	for _, suffix := range []string{"", "/", "//", "/////"} {
		base, err := parseBaseURL(" https://EXAMPLE.invalid/prefix" + suffix + " ")
		if err != nil || base.String() != "https://example.invalid/prefix" {
			t.Fatalf("URL canonicalization mismatch for %q: url=%v error=%v", suffix, base, err)
		}
	}
}

func TestBaseURLPreservesEscapedPathSegments(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.EscapedPath() != "/prefix%2F/api/check" {
			t.Errorf("escaped site prefix changed the upstream endpoint: %s", request.URL.EscapedPath())
		}
		reply(writer, `{"code":0,"data":{}}`)
	}))
	defer server.Close()
	for _, suffix := range []string{"", "/", "//"} {
		client, err := newAPIClient(server.URL+"/prefix%2F"+suffix, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		if client.base.String() != server.URL+"/prefix%2F" {
			t.Fatal("escaped slash was treated as a removable path separator")
		}
		if _, err := client.request(context.Background(), &Session{}, http.MethodGet, "/api/check", nil); err != nil {
			t.Fatal(err)
		}
	}
}

func TestSyncerRejectsCatalogOutsideSharedContract(t *testing.T) {
	for _, test := range []struct {
		name   string
		change func(*Catalog)
	}{
		{"description", func(catalog *Catalog) { catalog.Groups[0].Description = strings.Repeat("x", 2001) }},
		{"utf16 description", func(catalog *Catalog) { catalog.Groups[0].Description = strings.Repeat("😀", 1001) }},
		{"group name", func(catalog *Catalog) { catalog.Groups[0].Name = strings.Repeat("x", 201) }},
		{"platform", func(catalog *Catalog) { catalog.Groups[0].Platform = strings.Repeat("x", 101) }},
		{"model id", func(catalog *Catalog) { catalog.Groups[0].Models = []string{strings.Repeat("x", 301)} }},
		{"price expression", func(catalog *Catalog) {
			catalog.Groups[0].Prices = []ModelPrice{{Model: "model", Mode: "dynamic", Expression: strings.Repeat("x", 16001)}}
		}},
		{"multiplier", func(catalog *Catalog) {
			multiplier := 1e12 + 1
			catalog.Groups[0].Multiplier = &multiplier
		}},
		{"groups", func(catalog *Catalog) {
			catalog.Groups = make([]Group, 501)
			for index := range catalog.Groups {
				catalog.Groups[index] = Group{ID: string(rune(index + 1000)), Name: "group"}
			}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := testStore(t)
			importCredentials(t, store, testCredential())
			invalid := true
			provider := &stubProvider{fetch: func(context.Context, *Session) (Catalog, error) {
				catalog := Catalog{Scope: "public", Groups: []Group{{ID: "group", Name: "group"}}}
				if invalid {
					test.change(&catalog)
				}
				return catalog, nil
			}}
			results, err := (&Syncer{Store: store, Providers: registryFor(provider)}).Run(context.Background())
			if err == nil || len(results) != 1 || results[0].Catalog != nil || results[0].ErrorStage != "validate_catalog" {
				t.Fatalf("invalid upstream catalog became a successful saved callback: result=%+v error=%v", results, err)
			}
			sites, err := store.Sites(context.Background())
			if err != nil || sites[0].Snapshot != nil || sites[0].LastRun.ErrorStage != "validate_catalog" {
				t.Fatalf("invalid catalog was persisted as success: %v", err)
			}
			invalid = false
			results, err = (&Syncer{Store: store, Providers: registryFor(provider)}).Run(context.Background())
			if err != nil || len(results) != 1 || results[0].Catalog == nil || results[0].ErrorStage != "" {
				t.Fatalf("corrected upstream catalog did not recover on a new attempt: result=%+v error=%v", results, err)
			}
		})
	}
}

func TestNormalizeCatalogRetainsBoundaryData(t *testing.T) {
	catalog := Catalog{Scope: "public", Groups: []Group{{ID: " group ", Name: " group ", Description: strings.Repeat("😀", 1000), Models: []string{" model ", "model", ""}}}}
	if err := normalizeCatalog(&catalog); err != nil || catalog.Groups[0].ID != "group" || len(catalog.Groups[0].Models) != 1 || catalog.Groups[0].Models[0] != "model" {
		t.Fatalf("boundary catalog was not normalized safely: %v", err)
	}
	catalog.Groups = append(catalog.Groups, Group{ID: "group", Name: "duplicate"})
	if err := normalizeCatalog(&catalog); err == nil {
		t.Fatal("identities that collide after Node text normalization were accepted")
	}
}
