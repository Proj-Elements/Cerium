package cerium

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"path"
	"slices"
	"strings"
	"syscall"
	"time"

	"cerium/contracts"
)

const maxResponseBytes = 8 << 20

type apiClient struct {
	base   *url.URL
	client *http.Client
}

type envelope struct {
	Code         json.RawMessage    `json:"code"`
	Reason       string             `json:"reason"`
	Success      *bool              `json:"success"`
	Data         json.RawMessage    `json:"data"`
	GroupRatio   map[string]float64 `json:"group_ratio"`
	AutoGroups   []string           `json:"auto_groups"`
	UsableGroups map[string]string  `json:"usable_group"`
}

type APIError struct {
	Method string
	Path   string
	Status int
	Code   string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("%s %s: HTTP %d (API code %s)", e.Method, e.Path, e.Status, e.Code)
}

func hasStatus(err error, statuses ...int) bool {
	var e *APIError
	return errors.As(err, &e) && slices.Contains(statuses, e.Status)
}

func authRejected(err error) bool {
	var e *APIError
	if !errors.As(err, &e) {
		return false
	}
	return e.Status == http.StatusUnauthorized || e.Code == "401" ||
		slices.Contains([]string{"AUTH_UNAUTHORIZED", "AUTH_TOKEN_EXPIRED", "AUTH_TOKEN_INVALID", "UNAUTHORIZED", "TOKEN_EXPIRED", "INVALID_TOKEN"}, e.Code)
}

func parseBaseURL(raw string) (*url.URL, error) {
	canonical, err := contracts.CanonicalSiteURL(raw)
	if err != nil {
		return nil, errors.New("url must be an http(s) site URL without user info, query, or fragment")
	}
	return url.Parse(canonical)
}

func newAPIClient(raw string, timeout time.Duration) (*apiClient, error) {
	return newAPIClientWithTransport(raw, timeout, false)
}

// newAPIClientWithTransport keeps trusted service calls off upstream proxies.
func newAPIClientWithTransport(raw string, timeout time.Duration, direct bool) (*apiClient, error) {
	base, err := parseBaseURL(raw)
	if err != nil {
		return nil, err
	}
	client, err := newHTTPClient(timeout, direct)
	if err != nil {
		return nil, err
	}
	return &apiClient{base: base, client: client}, nil
}

func (c *apiClient) request(ctx context.Context, s *Session, method, endpoint string, body any) (envelope, error) {
	return c.requestWith(ctx, s, method, endpoint, body, requestOptions{})
}

type requestOptions struct {
	query   url.Values
	headers http.Header
	noRetry bool
}

func (c *apiClient) requestWith(ctx context.Context, s *Session, method, endpoint string, body any, opts requestOptions) (envelope, error) {
	var out envelope
	data, status, err := c.rawRequest(ctx, s, method, endpoint, body, opts)
	if err != nil {
		return out, err
	}
	decodeErr := json.Unmarshal(data, &out)
	code := "unspecified"
	if len(out.Code) > 0 {
		code = strings.Trim(string(out.Code), `"`)
	}
	if out.Reason != "" {
		code = out.Reason
	}
	// Upstream messages/bodies may echo secrets. Only retain short error codes.
	if len(code) > 64 || strings.ContainsFunc(code, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_')
	}) {
		code = "unspecified"
	}
	if status < 200 || status >= 300 ||
		(out.Success != nil && !*out.Success) || (out.Success == nil && len(out.Code) > 0 && string(out.Code) != "0") {
		return out, &APIError{Method: method, Path: endpoint, Status: status, Code: code}
	}
	if decodeErr != nil || (out.Success == nil && len(out.Code) == 0) {
		return out, fmt.Errorf("%s %s: expected an API JSON response", method, endpoint)
	}
	return out, nil
}

func (c *apiClient) rawRequest(ctx context.Context, s *Session, method, endpoint string, body any, opts requestOptions) ([]byte, int, error) {
	for attempt := 0; ; attempt++ {
		data, status, err := c.rawOnce(ctx, s, method, endpoint, body, opts)
		// Only replay safe reads after a broken connection, never token rotation,
		// key creation, solver task submission, or one-shot model discovery.
		transient := errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.EPIPE)
		if method != http.MethodGet || opts.noRetry || attempt == 1 || !transient || ctx.Err() != nil {
			return data, status, err
		}
		select {
		case <-ctx.Done():
			return nil, 0, ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
}

func (c *apiClient) rawOnce(ctx context.Context, s *Session, method, endpoint string, body any, opts requestOptions) ([]byte, int, error) {
	u := *c.base
	u.Path += endpoint
	if u.RawPath != "" {
		u.RawPath += endpoint
	}
	u.RawQuery = opts.query.Encode()
	var payload []byte
	var err error
	if body != nil {
		payload, err = json.Marshal(body)
		if err != nil {
			return nil, 0, errors.New("cannot encode API request")
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), bytes.NewReader(payload))
	if err != nil {
		return nil, 0, errors.New("cannot create API request")
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "cerium/0.1")
	req.Header.Set("Origin", c.base.Scheme+"://"+c.base.Host)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if s.AccessToken != "" {
		req.Header.Set("Authorization", "Bearer "+s.AccessToken)
	}
	if s.UserID > 0 {
		req.Header.Set("New-Api-User", fmt.Sprint(s.UserID))
	}
	if s.SessionID != "" {
		req.Header.Set("X-Auth-Session", s.SessionID)
	}
	for name, values := range opts.headers {
		req.Header[name] = values
	}
	// Do not let net/http replay a POST just because it has Idempotency-Key.
	if method != http.MethodGet && method != http.MethodHead {
		req.GetBody = nil
	}
	jar, _ := cookiejar.New(nil)
	jar.SetCookies(c.base, s.Cookies)
	client := *c.client
	client.Jar = jar
	if opts.noRetry {
		transport := c.client.Transport
		if transport == nil {
			transport = http.DefaultTransport
		}
		if base, ok := transport.(*http.Transport); ok {
			// A reused idle connection permits net/http's own transparent GET
			// replay, even when our explicit retry loop is disabled.
			fresh := base.Clone()
			fresh.DisableKeepAlives = true
			client.Transport = fresh
			defer fresh.CloseIdleConnections()
		}
	}
	resp, err := client.Do(req)
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return nil, 0, fmt.Errorf("%s %s: %w", method, endpoint, err)
	}
	defer resp.Body.Close()
	mergeCookies(s, req.URL, resp.Cookies())
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		return nil, resp.StatusCode, fmt.Errorf("%s %s: cannot read response: %w", method, endpoint, err)
	}
	if len(data) > maxResponseBytes {
		return nil, resp.StatusCode, fmt.Errorf("%s %s: response exceeds 8 MiB", method, endpoint)
	}
	return data, resp.StatusCode, nil
}

func decodeData[T any](e envelope) (T, error) {
	var v T
	if len(e.Data) == 0 || string(e.Data) == "null" || json.Unmarshal(e.Data, &v) != nil {
		return v, errors.New("API response has missing or invalid data")
	}
	return v, nil
}

func mergeCookies(s *Session, u *url.URL, cookies []*http.Cookie) {
	for _, cookie := range cookies {
		c := *cookie
		if c.Path == "" || c.Path[0] != '/' {
			c.Path = path.Dir(u.Path)
		}
		s.Cookies = slices.DeleteFunc(s.Cookies, func(old *http.Cookie) bool {
			return old.Name == c.Name && old.Path == c.Path && old.Domain == c.Domain
		})
		if c.MaxAge > 0 {
			c.Expires = time.Now().Add(time.Duration(c.MaxAge) * time.Second)
			c.MaxAge = 0
		}
		if c.MaxAge < 0 || (!c.Expires.IsZero() && c.Expires.Before(time.Now())) {
			continue
		}
		s.Cookies = append(s.Cookies, &c)
	}
}
