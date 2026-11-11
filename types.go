package cerium

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"cerium/contracts"
)

type Credential struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	URL         string `json:"url"`
	Type        string `json:"type"`
	Account     string `json:"account"`
	Password    string `json:"-"`
	AccessToken string `json:"-"`
	UserID      int64  `json:"user_id,omitempty"`
	Revision    int64  `json:"-"`
}

func normalizeAuth(c *Credential) error {
	if c.AccessToken != "" || c.UserID != 0 {
		c.AccessToken = strings.TrimSpace(c.AccessToken)
		if strings.EqualFold(c.AccessToken, "Bearer") {
			c.AccessToken = ""
		} else if len(c.AccessToken) >= 7 && strings.EqualFold(c.AccessToken[:7], "Bearer ") {
			c.AccessToken = strings.TrimSpace(c.AccessToken[7:])
		}
		if c.Type != "newapi" || c.UserID <= 0 || c.AccessToken == "" || len(c.AccessToken) > 16384 || strings.ContainsFunc(c.AccessToken, func(r rune) bool { return r < 33 || r > 126 }) {
			return errors.New("NewAPI token authentication requires a valid access_token and positive user_id")
		}
		if c.Account != "" || c.Password != "" {
			return errors.New("choose account/password or access_token/user_id, not both")
		}
	} else if c.Account == "" || c.Password == "" {
		return errors.New("account and password are required")
	}
	return nil
}

type Session struct {
	AccessToken  string         `json:"-"`
	RefreshToken string         `json:"-"`
	ExpiresAt    time.Time      `json:"-"`
	UserID       int64          `json:"-"`
	SessionID    string         `json:"-"`
	Cookies      []*http.Cookie `json:"-"`
}

func (s Session) Empty() bool {
	return s.AccessToken == "" && s.RefreshToken == "" && len(s.Cookies) == 0
}

type Group = contracts.Group

// Prices are USD-denominated site credits, with the group multiplier applied.
// Dynamic billing is deliberately not reduced to a misleading fixed price.
type ModelPrice = contracts.ModelPrice
type Catalog = contracts.Catalog
type Result = contracts.Result

type StoredSite struct {
	Credential Credential `json:"credential"`
	LastRun    *Result    `json:"last_run"`
	FetchedAt  *time.Time `json:"fetched_at"`
	Snapshot   *Catalog   `json:"snapshot"`
}

var ErrRefreshUnsupported = errors.New("refresh is not supported by this session or server")
var ErrInteractiveLogin = errors.New("login requires MFA or interactive verification; unattended password login is unavailable")
var ErrCredentialChanged = errors.New("credential changed during synchronization; discard the old session and run again")

// A provider mutates Session when a server rotates tokens or cookies. The runner
// persists it after authentication, before fetching any optional metadata.
// Provider errors are public: never include passwords, tokens, or raw auth bodies.
type Provider interface {
	Login(context.Context, *Session) error
	Refresh(context.Context, *Session) error
	Fetch(context.Context, *Session) (Catalog, error)
}

type ProviderFactory func(Credential, time.Duration) (Provider, error)
type Registry map[string]ProviderFactory

func DefaultProviders() Registry {
	return Registry{"sub2api": NewSub2API, "newapi": NewNewAPI}
}

func PublicProviders() Registry {
	return Registry{
		"sub2api": func(c Credential, t time.Duration) (Provider, error) {
			p, err := NewSub2API(c, t)
			if err == nil {
				p.(*sub2API).publicOnly = true
			}
			return p, err
		},
		"newapi": func(c Credential, t time.Duration) (Provider, error) {
			p, err := NewNewAPI(c, t)
			if err == nil {
				p.(*newAPI).publicOnly = true
			}
			return p, err
		},
	}
}

// Sink receives only the explicitly public result, never a credential/session.
type Sink interface {
	Publish(context.Context, Result) error
}
