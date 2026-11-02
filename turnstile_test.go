package cerium

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestSub2APITurnstileLogin(t *testing.T) {
	var submissions, polls, logins atomic.Int32
	solver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Error("credentials sent to solver")
		}
		switch r.URL.Path {
		case "/turnstile":
			submissions.Add(1)
			if r.URL.Query().Get("sitekey") != "public-sitekey" || !strings.HasSuffix(r.URL.Query().Get("url"), "/panel/login") {
				t.Error("wrong solver parameters")
			}
			w.WriteHeader(202)
			reply(w, `{"task_id":"fixture-task"}`)
		case "/result":
			if polls.Add(1) == 1 {
				reply(w, "CAPTCHA_NOT_READY")
			} else {
				reply(w, `{"value":"one-use-proof"}`)
			}
		default:
			t.Error("unexpected solver route")
		}
	}))
	defer solver.Close()
	t.Setenv("CERIUM_TURNSTILE_SOLVER_URL", solver.URL)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/panel/api/v1/settings/public" {
			reply(w, `{"code":0,"data":{"turnstile_enabled":true,"turnstile_site_key":"public-sitekey"}}`)
			return
		}
		if r.URL.Path != "/panel/api/v1/auth/login" {
			t.Error("unexpected upstream route")
		}
		logins.Add(1)
		var body map[string]string
		if json.NewDecoder(r.Body).Decode(&body) != nil || body["turnstile_token"] != "one-use-proof" || body["email"] != "user" || body["password"] != "password" {
			t.Error("login did not carry proof and credentials")
		}
		reply(w, `{"code":0,"data":{"access_token":"access","refresh_token":"refresh"}}`)
	}))
	defer upstream.Close()
	p, _ := NewSub2API(Credential{URL: upstream.URL + "/panel", Account: "user", Password: "password"}, time.Second)
	session := Session{}
	if err := p.Login(context.Background(), &session); err != nil || session.AccessToken != "access" {
		t.Fatalf("solver login failed: %v", err)
	}
	if submissions.Load() != 1 || polls.Load() != 2 || logins.Load() != 1 {
		t.Fatal("unexpected proof/login request count")
	}
}

func TestTurnstileFailuresAreBoundedAndRedacted(t *testing.T) {
	for _, body := range []string{`{"value":"CAPTCHA_FAIL"}`, `{"error":"private-token"}`, `not-json`, `{"value":"` + strings.Repeat("x", 2049) + `"}`} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/turnstile" {
				reply(w, `{"task_id":"fixture-task"}`)
			} else {
				reply(w, body)
			}
		}))
		_, err := solveTurnstile(context.Background(), server.URL, "https://example.invalid/login", "sitekey")
		server.Close()
		if err == nil || strings.Contains(err.Error(), "private-token") {
			t.Fatal("solver failure was accepted or leaked its response")
		}
	}
	if _, err := solveTurnstile(context.Background(), "", "https://example.invalid/login", "key"); err == nil {
		t.Fatal("missing solver accepted")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/turnstile" {
			reply(w, `{"task_id":"fixture-task"}`)
		} else {
			reply(w, "CAPTCHA_NOT_READY")
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := solveTurnstile(ctx, server.URL, "https://example.invalid/login", "key"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("solver ignored deadline: %v", err)
	}
}
