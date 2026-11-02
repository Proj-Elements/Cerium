package cerium

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// The optional local sidecar implements Theyka's task/result API. It receives
// only the login page and public sitekey, never account credentials or sessions.
func solveTurnstile(ctx context.Context, solverURL, pageURL, sitekey string) (string, error) {
	if solverURL == "" {
		return "", errors.New("Turnstile is enabled; configure CERIUM_TURNSTILE_SOLVER_URL")
	}
	client, err := newAPIClient(solverURL, 10*time.Second)
	if err != nil {
		return "", errors.New("invalid Turnstile solver URL")
	}
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	data, status, err := client.rawRequest(ctx, &Session{}, http.MethodGet, "/turnstile", nil, requestOptions{
		query: url.Values{"url": {pageURL}, "sitekey": {sitekey}}, noRetry: true,
	})
	if err != nil || status != 202 && status != 200 {
		return "", errors.New("Turnstile solver unavailable or rejected the task")
	}
	var task struct {
		ID string `json:"task_id"`
	}
	if json.Unmarshal(data, &task) != nil || task.ID == "" || len(task.ID) > 128 {
		return "", errors.New("Turnstile solver returned an invalid task ID")
	}
	for {
		select {
		case <-ctx.Done():
			return "", fmt.Errorf("Turnstile solve did not complete: %w", ctx.Err())
		case <-time.After(500 * time.Millisecond):
		}
		data, status, err = client.rawRequest(ctx, &Session{}, http.MethodGet, "/result", nil, requestOptions{query: url.Values{"id": {task.ID}}})
		if err != nil || status != 200 {
			return "", errors.New("Turnstile solver failed to produce a token")
		}
		if strings.Trim(string(data), "\" \n\r") == "CAPTCHA_NOT_READY" {
			continue
		}
		var result struct {
			Value string `json:"value"`
		}
		if json.Unmarshal(data, &result) != nil || result.Value == "" || result.Value == "CAPTCHA_FAIL" || len(result.Value) > 2048 {
			return "", errors.New("Turnstile solver failed to produce a valid token")
		}
		return result.Value, nil
	}
}

func (p *sub2API) loginProof(ctx context.Context) (string, error) {
	e, err := p.client.request(ctx, &Session{}, http.MethodGet, "/api/v1/settings/public", nil)
	if hasStatus(err, http.StatusNotFound, http.StatusMethodNotAllowed) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("discover login verification: %w", err)
	}
	settings, err := decodeData[struct {
		Enabled bool   `json:"turnstile_enabled"`
		SiteKey string `json:"turnstile_site_key"`
		Tencent bool   `json:"tencent_captcha_enabled"`
		Aliyun  bool   `json:"aliyun_captcha_enabled"`
	}](e)
	if err != nil {
		return "", err
	}
	if settings.Tencent || settings.Aliyun {
		return "", errors.New("this captcha provider is not supported by the Turnstile solver")
	}
	if !settings.Enabled {
		return "", nil
	}
	if settings.SiteKey == "" {
		return "", errors.New("Turnstile sitekey is missing from public settings")
	}
	return solveTurnstile(ctx, os.Getenv("CERIUM_TURNSTILE_SOLVER_URL"), p.client.base.String()+"/login", settings.SiteKey)
}
