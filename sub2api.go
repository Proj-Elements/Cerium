package cerium

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"
)

type sub2API struct {
	credential Credential
	client     *apiClient
	publicOnly bool
	store      *Store
}

func NewSub2API(c Credential, timeout time.Duration) (Provider, error) {
	client, err := newAPIClient(c.URL, timeout)
	if err != nil {
		return nil, err
	}
	return &sub2API{credential: c, client: client}, nil
}

type sub2Tokens struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int64  `json:"expires_in"`
	Requires2FA  bool   `json:"requires_2fa"`
}

func applySub2Tokens(s *Session, e envelope) error {
	tokens, err := decodeData[sub2Tokens](e)
	if err != nil {
		return err
	}
	if tokens.Requires2FA {
		return ErrInteractiveLogin
	}
	if tokens.AccessToken == "" {
		return errors.New("Sub2API did not return an access token")
	}
	s.AccessToken, s.RefreshToken = tokens.AccessToken, tokens.RefreshToken
	s.ExpiresAt = time.Time{}
	if tokens.ExpiresIn > 0 && tokens.ExpiresIn <= int64((365*24*time.Hour)/time.Second) {
		s.ExpiresAt = time.Now().UTC().Add(time.Duration(tokens.ExpiresIn) * time.Second)
	}
	return nil
}

func (p *sub2API) Login(ctx context.Context, s *Session) error {
	*s = Session{}
	proof, err := p.loginProof(ctx)
	if err != nil {
		return err
	}
	body := map[string]string{
		"email": p.credential.Account, "password": p.credential.Password,
	}
	if proof != "" {
		body["turnstile_token"] = proof
	}
	e, err := p.client.request(ctx, s, http.MethodPost, "/api/v1/auth/login", body)
	if err != nil {
		return err
	}
	return applySub2Tokens(s, e)
}

func (p *sub2API) Refresh(ctx context.Context, s *Session) error {
	if s.RefreshToken == "" {
		return ErrRefreshUnsupported
	}
	e, err := p.client.request(ctx, s, http.MethodPost, "/api/v1/auth/refresh", map[string]string{"refresh_token": s.RefreshToken})
	if err != nil {
		return err
	}
	return applySub2Tokens(s, e)
}

func (p *sub2API) Fetch(ctx context.Context, s *Session) (Catalog, error) {
	catalog := Catalog{Groups: []Group{}}
	e, err := p.client.request(ctx, s, http.MethodGet, "/api/v1/groups/available", nil)
	if err != nil {
		return catalog, err
	}
	type availableGroup struct {
		ID               int64    `json:"id"`
		Name             string   `json:"name"`
		Description      string   `json:"description"`
		Platform         string   `json:"platform"`
		RateMultiplier   *float64 `json:"rate_multiplier"`
		IsExclusive      *bool    `json:"is_exclusive"`
		SubscriptionType string   `json:"subscription_type"`
	}
	groups, err := decodeData[[]availableGroup](e)
	if err != nil {
		return catalog, err
	}
	if p.publicOnly {
		catalog.Scope = "public"
	}
	for _, g := range groups {
		if p.publicOnly && (g.IsExclusive == nil || *g.IsExclusive || g.SubscriptionType != "standard") {
			if g.IsExclusive == nil || g.SubscriptionType == "" {
				catalog.Warnings = append(catalog.Warnings, "a group lacks explicit visibility metadata and was withheld from the public directory")
			}
			continue
		}
		catalog.Groups = append(catalog.Groups, Group{
			ID: strconv.FormatInt(g.ID, 10), Name: g.Name, Description: g.Description, Platform: g.Platform,
			Multiplier: g.RateMultiplier, DefaultMultiplier: g.RateMultiplier, MultiplierSource: "group",
		})
	}
	if len(catalog.Groups) == 0 {
		err = p.discoverModels(ctx, s, &catalog)
		return catalog, err
	}
	if !p.publicOnly {
		e, err = p.client.request(ctx, s, http.MethodGet, "/api/v1/groups/rates", nil)
		if authRejected(err) {
			return catalog, err
		}
		var rates map[string]float64
		if err == nil && string(e.Data) != "null" {
			rates, err = decodeData[map[string]float64](e)
		}
		if err != nil {
			catalog.Warnings = append(catalog.Warnings, fmt.Sprintf("personalized group rates unavailable; showing group defaults: %v", err))
			for i := range catalog.Groups {
				catalog.Groups[i].MultiplierSource = "group_fallback"
			}
		} else {
			for i := range catalog.Groups {
				g := &catalog.Groups[i]
				if rate, ok := rates[g.ID]; ok {
					g.Multiplier, g.MultiplierSource = &rate, "user"
				}
			}
		}
	}
	err = p.discoverModels(ctx, s, &catalog)
	return catalog, err
}
