package cerium

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"math"
	"slices"
	"strings"
	"time"
)

type Syncer struct {
	Store          *Store
	Providers      Registry
	Sinks          []Sink
	RequestTimeout time.Duration
	SiteTimeout    time.Duration
}

// Run performs one bounded synchronization per stored credential. A failed site
// does not stop the other sites, and optional metadata failures become warnings.
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
	results := []Result{}
	var failures []error
	for _, c := range credentials {
		if ctx.Err() != nil {
			failures = append(failures, ctx.Err())
			break
		}
		siteCtx, cancel := context.WithTimeout(ctx, siteTimeout)
		r, runErr := s.syncOne(siteCtx, c, providers, requestTimeout, siteTimeout)
		cancel()
		if runErr != nil {
			r.Error = runErr.Error()
			failures = append(failures, fmt.Errorf("credential %d: %w", c.ID, runErr))
		}
		results = append(results, r)
		for _, sink := range s.Sinks {
			if err := sink.Publish(ctx, r); err != nil {
				failures = append(failures, fmt.Errorf("credential %d: publish result: %w", c.ID, err))
			}
		}
	}
	return results, errors.Join(failures...)
}

func (s *Syncer) syncOne(ctx context.Context, c Credential, providers Registry, requestTimeout, siteTimeout time.Duration) (result Result, err error) {
	result = Result{CredentialID: c.ID, Name: c.Name, URL: c.URL, Type: c.Type, CheckedAt: time.Now().UTC(), Refresh: "not_attempted"}
	owner := rand.Text()
	acquired, err := s.Store.acquire(ctx, c.ID, owner, time.Now().Add(siteTimeout+30*time.Second))
	if err != nil {
		return result, err
	}
	if !acquired {
		return result, errors.New("another synchronization owns this credential; no request was made")
	}
	defer func() {
		if err != nil {
			result.Error = err.Error()
		}
		saveCtx, saveCancel := persistenceContext(ctx)
		saveErr := s.Store.SaveResult(saveCtx, c, result)
		saveCancel()
		if saveErr != nil {
			err = errors.Join(err, fmt.Errorf("save result: %w", saveErr))
		}
		releaseCtx, cancel := persistenceContext(ctx)
		defer cancel()
		err = errors.Join(err, s.Store.release(releaseCtx, c.ID, owner))
	}()
	factory, ok := providers[c.Type]
	if !ok || factory == nil {
		return result, fmt.Errorf("unsupported provider type: %s", c.Type)
	}
	provider, err := factory(c, requestTimeout)
	if err != nil {
		return result, err
	}
	if p, ok := provider.(*sub2API); ok {
		p.store = s.Store
	}
	session, err := s.Store.Session(ctx, c.ID)
	if err != nil {
		return result, err
	}
	saveSession := func() error {
		saveCtx, cancel := persistenceContext(ctx)
		defer cancel()
		return s.Store.SaveSession(saveCtx, c, session)
	}
	loggedIn := false
	login := func() error {
		if err := provider.Login(ctx, &session); err != nil {
			return err
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
		return result, fmt.Errorf("fetch groups: %w", fetchErr)
	}
	if err := normalizeCatalog(&catalog); err != nil {
		return result, err
	}
	result.Catalog = &catalog
	return result, nil
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
		if g.ID == "" || g.Name == "" || ids[g.ID] {
			return errors.New("API returned empty or duplicate group identities")
		}
		ids[g.ID] = true
		for _, ratio := range []*float64{g.Multiplier, g.DefaultMultiplier} {
			if ratio != nil && (math.IsNaN(*ratio) || math.IsInf(*ratio, 0) || *ratio < 0) {
				return errors.New("API returned an invalid negative or nonfinite group multiplier")
			}
		}
		g.Models = slices.DeleteFunc(g.Models, func(name string) bool { return name == "" })
		slices.Sort(g.Models)
		g.Models = slices.Compact(g.Models)
		if g.ModelsKnown && g.Models == nil {
			g.Models = []string{}
		}
	}
	slices.SortFunc(c.Groups, func(a, b Group) int {
		if n := strings.Compare(a.Name, b.Name); n != 0 {
			return n
		}
		return strings.Compare(a.ID, b.ID)
	})
	return nil
}
