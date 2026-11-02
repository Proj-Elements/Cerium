package cerium

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"slices"
)

type pricingModel struct {
	Name             string            `json:"model_name"`
	Groups           []string          `json:"enable_groups"`
	QuotaType        *int              `json:"quota_type"`
	ModelRatio       *float64          `json:"model_ratio"`
	ModelPrice       *float64          `json:"model_price"`
	CompletionRatio  *float64          `json:"completion_ratio"`
	CacheRatio       *float64          `json:"cache_ratio"`
	CreateCacheRatio *float64          `json:"create_cache_ratio"`
	BillingMode      string            `json:"billing_mode"`
	BillingExpr      string            `json:"billing_expr"`
	Plugins          []json.RawMessage `json:"billing_plugin_variants"`
}

func product(values ...*float64) *float64 {
	n := 1.0
	for _, v := range values {
		if v == nil || *v < 0 {
			return nil
		}
		n *= *v
	}
	if math.IsNaN(n) || math.IsInf(n, 0) {
		return nil
	}
	return &n
}

func (m pricingModel) price(ratio *float64) ModelPrice {
	p := ModelPrice{Model: m.Name, Mode: "unknown"}
	if m.BillingExpr != "" || len(m.Plugins) > 0 || (m.BillingMode != "" && m.BillingMode != "ratio") {
		p.Mode, p.Expression = "dynamic", m.BillingExpr
		return p
	}
	if ratio == nil || m.QuotaType == nil {
		return p
	}
	switch *m.QuotaType {
	case 0:
		two := 2.0
		p.Mode = "tokens"
		p.Input = product(m.ModelRatio, &two, ratio)
		p.Output = product(p.Input, m.CompletionRatio)
		p.CacheRead = product(p.Input, m.CacheRatio)
		p.CacheWrite = product(p.Input, m.CreateCacheRatio)
	case 1:
		p.Mode, p.Request = "request", product(m.ModelPrice, ratio)
	}
	return p
}

func (p *newAPI) fetchPublic(ctx context.Context) (Catalog, error) {
	catalog := Catalog{Groups: []Group{}, Scope: "public"}
	// A fresh, empty session is essential: authenticated prices can reveal
	// private groups and personalized rates that must never reach the directory.
	e, err := p.client.request(ctx, &Session{}, http.MethodGet, "/api/pricing", nil)
	if err != nil {
		return catalog, err
	}
	if e.UsableGroups == nil {
		return catalog, errors.New("public pricing does not declare usable_group; refusing account-private fallback")
	}
	models, err := decodeData[[]pricingModel](e)
	if err != nil {
		return catalog, err
	}
	for name, description := range e.UsableGroups {
		g := Group{ID: name, Name: name, Description: description, Models: []string{}, ModelsKnown: true, MultiplierSource: "public"}
		if name == "auto" {
			g.MultiplierSource = "auto"
		} else if r, ok := e.GroupRatio[name]; ok {
			g.Multiplier, g.DefaultMultiplier = &r, &r
		}
		for _, model := range models {
			if model.Groups == nil {
				g.ModelsKnown = false
			}
			matches := slices.Contains(model.Groups, name) || slices.Contains(model.Groups, "all")
			if name == "auto" {
				if e.AutoGroups == nil {
					g.ModelsKnown = false
				}
				for _, a := range e.AutoGroups {
					matches = matches || slices.Contains(model.Groups, a)
				}
			}
			if matches {
				g.Models = append(g.Models, model.Name)
				g.Prices = append(g.Prices, model.price(g.Multiplier))
			}
		}
		catalog.Groups = append(catalog.Groups, g)
	}
	return catalog, nil
}
