package cerium

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

type Webhook struct {
	url    string
	secret []byte
	client *http.Client
}

// WebhookError reports the callback status without retaining its body or URL.
type WebhookError struct {
	Status int
}

func (e *WebhookError) Error() string {
	return fmt.Sprintf("webhook returned HTTP %d", e.Status)
}

func (e *WebhookError) permanent() bool {
	return e.Status == http.StatusBadRequest || e.Status == http.StatusConflict ||
		e.Status == http.StatusGone || e.Status == http.StatusRequestEntityTooLarge || e.Status == http.StatusUnprocessableEntity
}

func NewWebhook(rawURL, secret string, timeout time.Duration) (*Webhook, error) {
	u, err := url.Parse(rawURL)
	if err != nil || u.Hostname() == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || u.Fragment != "" {
		return nil, errors.New("webhook must be an http(s) URL without user info or fragment")
	}
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	client, err := newHTTPClient(timeout, true)
	if err != nil {
		return nil, err
	}
	return &Webhook{url: u.String(), secret: []byte(secret), client: client}, nil
}

func (w *Webhook) Publish(ctx context.Context, result Result) error {
	body, err := json.Marshal(result)
	if err != nil {
		return errors.New("cannot encode webhook payload")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, w.url, bytes.NewReader(body))
	if err != nil {
		return errors.New("cannot create webhook request")
	}
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "cerium/0.1")
	req.Header.Set("X-Cerium-Event", "sync.completed")
	req.Header.Set("X-Cerium-Timestamp", timestamp)
	if len(w.secret) > 0 {
		mac := hmac.New(sha256.New, w.secret)
		mac.Write([]byte(timestamp + "\n"))
		mac.Write(body)
		req.Header.Set("X-Cerium-Signature", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	}
	resp, err := w.client.Do(req)
	if err != nil {
		// A webhook URL can itself contain a credential. Do not echo it.
		return errors.New("webhook request failed or timed out")
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &WebhookError{Status: resp.StatusCode}
	}
	return nil
}
