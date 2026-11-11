package cerium

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	"cerium/contracts"
)

type Syncer struct {
	Store          *Store
	Providers      Registry
	Sinks          []Sink
	RequestTimeout time.Duration
	SiteTimeout    time.Duration
	MaxConcurrency int
}

// Run synchronizes independent credentials with at most MaxConcurrency workers
// (default four, capped at sixteen), preserving result and sink-delivery order.
// A failed site does not stop others, and optional failures become warnings.
func (s *Syncer) Run(ctx context.Context) ([]Result, error) {
	if s.Store == nil {
		return nil, errors.New("a SQLite store is required")
	}
	providers := s.Providers
	if providers == nil {
		providers = DefaultProviders()
	}
	requestTimeout, siteTimeout := s.RequestTimeout, s.SiteTimeout
	if requestTimeout <= 0 {
		requestTimeout = 20 * time.Second
	}
	if siteTimeout <= 0 {
		siteTimeout = 2 * time.Minute
	}
	credentials, err := s.Store.Credentials(ctx)
	if err != nil {
		return nil, err
	}
	concurrency := s.MaxConcurrency
	if concurrency <= 0 {
		concurrency = 4
	}
	concurrency = min(concurrency, 16, len(credentials))
	completed := make([]bool, len(credentials))
	ordered := make([]Result, len(credentials))
	failures := make([]error, len(credentials))
	jobs := make(chan int)
	var workers sync.WaitGroup
	for range concurrency {
		workers.Go(func() {
			for index := range jobs {
				credential := credentials[index]
				siteCtx, cancel := context.WithTimeout(ctx, siteTimeout)
				result, runErr := s.syncOne(siteCtx, credential, providers, requestTimeout, siteTimeout)
				cancel()
				if runErr != nil {
					failures[index] = fmt.Errorf("credential %d: %w", credential.ID, runErr)
				}
				ordered[index], completed[index] = result, true
			}
		})
	}
dispatch:
	for index := range credentials {
		if ctx.Err() != nil {
			break
		}
		select {
		case jobs <- index:
		case <-ctx.Done():
			break dispatch
		}
	}
	close(jobs)
	workers.Wait()
	results := make([]Result, 0, len(credentials))
	for index, result := range ordered {
		if !completed[index] {
			continue
		}
		results = append(results, result)
		for _, sink := range s.Sinks {
			if err := sink.Publish(ctx, result); err != nil {
				failures[index] = errors.Join(failures[index], fmt.Errorf("credential %d: publish result: %w", result.CredentialID, err))
			}
		}
	}
	if len(results) < len(credentials) {
		failures = append(failures, ctx.Err())
	}
	return results, errors.Join(failures...)
}

func (s *Syncer) syncOne(ctx context.Context, c Credential, providers Registry, requestTimeout, siteTimeout time.Duration) (result Result, err error) {
	result = Result{CredentialID: c.ID, Name: c.Name, URL: c.URL, Type: c.Type, CheckedAt: time.Now().UTC(), Refresh: "not_attempted"}
	defer func() { diagnoseResult(&result, err) }()
	owner := rand.Text()
	acquired, err := s.Store.acquireCredential(ctx, c, owner, time.Now().Add(siteTimeout+30*time.Second))
	if err != nil {
		return result, atStage("acquire_lease", err)
	}
	if !acquired {
		return result, atStage("acquire_lease", errSynchronizationBusy)
	}
	defer func() {
		diagnoseResult(&result, err)
		saveCtx, saveCancel := persistenceContext(ctx)
		saveErr := s.Store.SaveResult(saveCtx, c, result)
		saveCancel()
		if saveErr != nil {
			err = errors.Join(err, atStage("save_result", fmt.Errorf("save result: %w", saveErr)))
		}
		releaseCtx, cancel := persistenceContext(ctx)
		defer cancel()
		if releaseErr := s.Store.release(releaseCtx, c.ID, owner); releaseErr != nil {
			err = errors.Join(err, atStage("release_lease", releaseErr))
		}
	}()
	factory, ok := providers[c.Type]
	if !ok || factory == nil {
		return result, atStage("configure_provider", fmt.Errorf("unsupported provider type: %s", c.Type))
	}
	provider, err := factory(c, requestTimeout)
	if err != nil {
		return result, atStage("configure_provider", err)
	}
	if p, ok := provider.(*sub2API); ok {
		p.store = s.Store
	}
	session, err := s.Store.Session(ctx, c.ID)
	if err != nil {
		return result, atStage("load_session", err)
	}
	saveSession := func() error {
		saveCtx, cancel := persistenceContext(ctx)
		defer cancel()
		if err := s.Store.SaveSession(saveCtx, c, session); err != nil {
			return atStage("persist_session", err)
		}
		return nil
	}
	loggedIn := false
	login := func() error {
		if err := provider.Login(ctx, &session); err != nil {
			return atStage("login", err)
		}
		loggedIn = true
		return saveSession()
	}
	if session.Empty() {
		if err := login(); err != nil {
			return result, fmt.Errorf("login: %w", err)
		}
	}
	refreshErr := provider.Refresh(ctx, &session)
	switch {
	case refreshErr == nil:
		result.Refresh = "rotated"
		// Refresh tokens may be single-use. Commit their replacement before any
		// group request, even when that later request fails or is cancelled.
		if err := saveSession(); err != nil {
			return result, fmt.Errorf("persist rotated session: %w", err)
		}
	case errors.Is(refreshErr, ErrRefreshUnsupported):
		result.Refresh = "unsupported"
	default:
		result.Refresh = "failed"
		result.Warnings = append(result.Warnings, fmt.Sprintf("refresh failed; attempting to use or recover the login session: %v", refreshErr))
		if authRejected(refreshErr) && !loggedIn {
			if err := login(); err != nil {
				return result, fmt.Errorf("re-login after rejected refresh: %w", err)
			}
		}
	}
	catalog, fetchErr := provider.Fetch(ctx, &session)
	if authRejected(fetchErr) && !loggedIn {
		if err := login(); err != nil {
			return result, fmt.Errorf("re-login after rejected session: %w", err)
		}
		// Authentication recovery is bounded to one login. Never refresh twice
		// in one run, and never retry a failed rotating refresh request.
		catalog, fetchErr = provider.Fetch(ctx, &session)
	}
	if err := saveSession(); err != nil {
		return result, fmt.Errorf("persist session: %w", err)
	}
	if fetchErr != nil {
		return result, atStage("fetch_catalog", fmt.Errorf("fetch groups: %w", fetchErr))
	}
	if err := normalizeCatalog(&catalog); err != nil {
		return result, atStage("validate_catalog", err)
	}
	result.Catalog = &catalog
	return result, nil
}

var errSynchronizationBusy = errors.New("another synchronization owns this credential; no request was made")

type syncStageError struct {
	stage string
	cause error
}

func (err *syncStageError) Error() string { return err.cause.Error() }
func (err *syncStageError) Unwrap() error { return err.cause }

func atStage(stage string, err error) error {
	return &syncStageError{stage: stage, cause: err}
}

func diagnoseResult(result *Result, err error) {
	if err == nil {
		return
	}
	result.Error = err.Error()
	result.ErrorStage = "synchronize"
	var staged *syncStageError
	if errors.As(err, &staged) {
		result.ErrorStage = staged.stage
	}
	var upstream *APIError
	var network net.Error
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		result.ErrorCategory = "timeout"
	case errors.As(err, &network) && network.Timeout():
		result.ErrorCategory = "timeout"
	case errors.Is(err, context.Canceled):
		result.ErrorCategory = "canceled"
	case errors.Is(err, ErrCredentialChanged):
		result.ErrorCategory = "credential_changed"
	case errors.Is(err, errSynchronizationBusy):
		result.ErrorCategory = "busy"
	case errors.Is(err, ErrInteractiveLogin):
		result.ErrorCategory = "interactive_auth"
	case authRejected(err):
		result.ErrorCategory = "authentication"
	case hasStatus(err, 403):
		result.ErrorCategory = "permission"
	case hasStatus(err, 429):
		result.ErrorCategory = "rate_limited"
	case errors.As(err, &upstream):
		result.ErrorCategory = "upstream_http"
	case errors.As(err, &network):
		result.ErrorCategory = "network"
	case errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF), errors.Is(err, syscall.ECONNRESET), errors.Is(err, syscall.ECONNREFUSED), errors.Is(err, syscall.EPIPE):
		result.ErrorCategory = "network"
	case slices.Contains([]string{"acquire_lease", "load_session", "persist_session", "save_result", "release_lease"}, result.ErrorStage):
		result.ErrorCategory = "persistence"
	case result.ErrorStage == "configure_provider" || result.ErrorStage == "validate_catalog":
		result.ErrorCategory = "invalid_response"
	default:
		result.ErrorCategory = "upstream_error"
	}
}

func persistenceContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
}

func normalizeCatalog(c *Catalog) error {
	if c.Groups == nil {
		c.Groups = []Group{}
	}
	ids := make(map[string]bool, len(c.Groups))
	for i := range c.Groups {
		g := &c.Groups[i]
		g.ID, g.Name = strings.TrimSpace(g.ID), strings.TrimSpace(g.Name)
		if g.ID == "" || g.Name == "" || ids[g.ID] {
			return errors.New("API returned empty or duplicate group identities")
		}
		ids[g.ID] = true
		for _, ratio := range []*float64{g.Multiplier, g.DefaultMultiplier} {
			if ratio != nil && (math.IsNaN(*ratio) || math.IsInf(*ratio, 0) || *ratio < 0) {
				return errors.New("API returned an invalid negative or nonfinite group multiplier")
			}
		}
		for index := range g.Models {
			g.Models[index] = strings.TrimSpace(g.Models[index])
		}
		g.Models = slices.DeleteFunc(g.Models, func(name string) bool { return name == "" })
		slices.Sort(g.Models)
		g.Models = slices.Compact(g.Models)
		if g.Models == nil {
			g.Models = []string{}
		}
	}
	slices.SortFunc(c.Groups, func(a, b Group) int {
		if n := strings.Compare(a.Name, b.Name); n != 0 {
			return n
		}
		return strings.Compare(a.ID, b.ID)
	})
	if err := contracts.ValidateCatalog(c); err != nil {
		return fmt.Errorf("API catalog exceeds the shared data contract: %w", err)
	}
	return nil
}
