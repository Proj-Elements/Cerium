package cerium

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"time"
)

type newAPI struct {
	credential Credential
	client     *apiClient
	publicOnly bool
}

func NewNewAPI(c Credential, timeout time.Duration) (Provider, error) {
	if c.AccessToken != "" || c.UserID != 0 {
		if err := normalizeAuth(&c); err != nil {
			return nil, err
		}
	}
	client, err := newAPIClient(c.URL, timeout)
	if err != nil {
		return nil, err
	}
	return &newAPI{credential: c, client: client}, nil
}

func (p *newAPI) Login(ctx context.Context, s *Session) error {
	*s = Session{}
	if p.credential.AccessToken != "" {
		s.AccessToken, s.UserID = p.credential.AccessToken, p.credential.UserID
		return nil
	}
	body := map[string]string{"username": p.credential.Account, "password": p.credential.Password}
	e, err := p.client.request(ctx, s, http.MethodGet, "/api/user/login/encryption-key", nil)
	if err != nil && !hasStatus(err, http.StatusNotFound, http.StatusMethodNotAllowed) {
		return err
	}
	if err == nil {
		key, err := decodeData[struct {
			Enabled   bool   `json:"enabled"`
			KID       string `json:"kid"`
			PublicKey string `json:"public_key"`
		}](e)
		if err != nil {
			return err
		}
		if key.Enabled {
			if key.KID == "" {
				return errors.New("NewAPI password encryption key ID is missing")
			}
			encrypted, err := encryptPassword(p.credential.Password, key.KID, key.PublicKey)
			if err != nil {
				return err
			}
			delete(body, "password")
			body["password_encrypted"], body["encryption_key_id"] = encrypted, key.KID
		}
	}
	e, err = p.client.request(ctx, s, http.MethodPost, "/api/user/login", body)
	if err != nil {
		return err
	}
	return applyNewAPISession(s, e)
}

func applyNewAPISession(s *Session, e envelope) error {
	data, err := decodeData[struct {
		ID                  int64  `json:"id"`
		AccessToken         string `json:"access_token"`
		AccessExpiresAt     int64  `json:"access_expires_at"`
		Require2FA          bool   `json:"require_2fa"`
		RequireVerification bool   `json:"require_verification"`
		User                struct {
			ID int64 `json:"id"`
		} `json:"user"`
		Session struct {
			SID string `json:"sid"`
		} `json:"session"`
	}](e)
	if err != nil {
		return err
	}
	if data.Require2FA || data.RequireVerification {
		return ErrInteractiveLogin
	}
	if data.AccessToken == "" && (data.ID <= 0 || len(s.Cookies) == 0) {
		return errors.New("NewAPI returned neither a token nor an authenticated legacy session")
	}
	s.AccessToken = data.AccessToken
	s.UserID = max(data.ID, data.User.ID)
	s.SessionID = data.Session.SID
	s.ExpiresAt = time.Time{}
	if data.AccessExpiresAt > 0 {
		s.ExpiresAt = time.Unix(data.AccessExpiresAt, 0).UTC()
	}
	s.RefreshToken = ""
	for _, cookie := range s.Cookies {
		if cookie.Name == "new_api_refresh" {
			s.RefreshToken = cookie.Value
		}
	}
	return nil
}

func (p *newAPI) Refresh(ctx context.Context, s *Session) error {
	if p.credential.AccessToken != "" || s.AccessToken == "" || s.RefreshToken == "" {
		return ErrRefreshUnsupported
	}
	e, err := p.client.request(ctx, s, http.MethodPost, "/api/user/auth/refresh", nil)
	if err != nil {
		return err
	}
	return applyNewAPISession(s, e)
}

func (p *newAPI) Fetch(ctx context.Context, s *Session) (Catalog, error) {
	if p.publicOnly && p.credential.AccessToken == "" {
		return p.fetchPublic(ctx)
	}
	catalog := Catalog{Groups: []Group{}}
	// Pricing can be public on legacy NewAPI. Validate the session using a
	// protected endpoint first, or an expired cookie silently yields guest rates.
	e, err := p.client.request(ctx, s, http.MethodGet, "/api/user/self/groups", nil)
	if err != nil {
		if p.credential.AccessToken != "" && (authRejected(err) || hasStatus(err, http.StatusOK, http.StatusForbidden)) {
			return catalog, errors.New("NewAPI access token, user ID or group permission was rejected; update the configured panel access token and user ID")
		}
		return catalog, err
	}
	if p.publicOnly {
		return p.fetchPublic(ctx)
	}
	data, err := decodeData[map[string]struct {
		Ratio json.RawMessage `json:"ratio"`
		Desc  string          `json:"desc"`
	}](e)
	if err != nil {
		return catalog, err
	}
	for name, v := range data {
		g := Group{ID: name, Name: name, Description: v.Desc, MultiplierSource: "unknown"}
		if name == "auto" || string(v.Ratio) == `"auto"` {
			g.MultiplierSource = "auto"
		} else if len(v.Ratio) > 0 && string(v.Ratio) != "null" {
			var ratio float64
			if json.Unmarshal(v.Ratio, &ratio) != nil {
				return catalog, errors.New("NewAPI returned an invalid group ratio")
			}
			g.Multiplier, g.MultiplierSource = &ratio, "user"
		}
		catalog.Groups = append(catalog.Groups, g)
	}
	if len(catalog.Groups) == 0 {
		return catalog, nil
	}
	e, err = p.client.request(ctx, s, http.MethodGet, "/api/pricing", nil)
	if authRejected(err) {
		return catalog, err
	}
	var models []pricingModel
	if err == nil {
		models, err = decodeData[[]pricingModel](e)
	}
	if err != nil {
		catalog.Warnings = append(catalog.Warnings, fmt.Sprintf("model metadata unavailable; group ratios remain available: %v", err))
		return catalog, nil
	}
	complete := true
	for _, m := range models {
		if m.Groups == nil {
			complete = false
		}
	}
	for i := range catalog.Groups {
		g := &catalog.Groups[i]
		g.ModelsKnown = complete
		if g.MultiplierSource == "auto" && e.AutoGroups == nil {
			g.ModelsKnown = false
		}
		if g.ModelsKnown {
			g.Models = []string{}
		}
		if g.Multiplier == nil && g.MultiplierSource != "auto" {
			if rate, ok := e.GroupRatio[g.ID]; ok {
				g.Multiplier, g.MultiplierSource = &rate, "user_pricing"
			}
		}
		for _, m := range models {
			matches := slices.Contains(m.Groups, g.ID) || slices.Contains(m.Groups, "all")
			if g.MultiplierSource == "auto" {
				for _, autoGroup := range e.AutoGroups {
					matches = matches || slices.Contains(m.Groups, autoGroup)
				}
			}
			if matches {
				g.Models = append(g.Models, m.Name)
				g.Prices = append(g.Prices, m.price(g.Multiplier))
			}
		}
	}
	if !complete {
		catalog.Warnings = append(catalog.Warnings, "some pricing entries have no enable_groups; model lists may be incomplete")
	}
	return catalog, nil
}

func encryptPassword(password, kid, publicPEM string) (string, error) {
	block, _ := pem.Decode([]byte(publicPEM))
	if block == nil {
		return "", errors.New("invalid NewAPI password encryption public key")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return "", errors.New("invalid NewAPI password encryption public key")
	}
	key, ok := parsed.(*rsa.PublicKey)
	if !ok || key.N.BitLen() < 2048 || key.N.BitLen() > 8192 {
		return "", errors.New("NewAPI password encryption requires a 2048-8192 bit RSA key")
	}
	if len(password) <= key.Size()-2*sha256.Size-2 {
		data, err := rsa.EncryptOAEP(sha256.New(), rand.Reader, key, []byte(password), nil)
		if err != nil {
			return "", errors.New("cannot encrypt NewAPI password")
		}
		return base64.StdEncoding.EncodeToString(data), nil
	}
	// Current NewAPI supports a hybrid v2 envelope for passwords exceeding the
	// RSA-OAEP payload limit; its label/AAD are part of the upstream contract.
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return "", err
	}
	wrapped, err := rsa.EncryptOAEP(sha256.New(), rand.Reader, key, secret, []byte("password-v2"))
	if err != nil {
		return "", errors.New("cannot encrypt NewAPI password key")
	}
	aesBlock, err := aes.NewCipher(secret)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(aesBlock)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nil, nonce, []byte(password), []byte("password-v2:"+kid))
	return "v2." + base64.StdEncoding.EncodeToString(wrapped) + "." + base64.StdEncoding.EncodeToString(nonce) + "." + base64.StdEncoding.EncodeToString(sealed), nil
}
