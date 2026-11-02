package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestCLIImportRunShowAndRemove(t *testing.T) {
	t.Setenv("CERIUM_WEBHOOK_URL", "")
	var logins, refreshes atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/settings/public":
			fmt.Fprint(w, `{"code":0,"data":{"turnstile_enabled":false}}`)
		case "/api/v1/auth/login":
			logins.Add(1)
			fmt.Fprint(w, `{"code":0,"data":{"access_token":"private-at","refresh_token":"private-rt"}}`)
		case "/api/v1/auth/refresh":
			refreshes.Add(1)
			fmt.Fprint(w, `{"code":0,"data":{"access_token":"private-new-at","refresh_token":"private-new-rt"}}`)
		case "/api/v1/groups/available":
			fmt.Fprint(w, `{"code":0,"data":[]}`)
		default:
			t.Errorf("unexpected API request %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	database := filepath.Join(t.TempDir(), "cerium.db")
	config := fmt.Sprintf(`{"credentials":[{"name":"demo","url":%q,"type":"sub2api","account":"user@example.com","password":"private-password"}]}`, server.URL)
	for _, command := range [][]string{
		{"import", "-config", "-"}, {"list"}, {"run"}, {"show"}, {"remove", "-id", "1"}, {"show"},
	} {
		var stdout, stderr bytes.Buffer
		args := append(append([]string{}, command...), "-db", database)
		if err := run(context.Background(), args, strings.NewReader(config), &stdout, &stderr); err != nil {
			t.Fatalf("%s: %v, stderr=%s", command[0], err, stderr.String())
		}
		if !json.Valid(stdout.Bytes()) {
			t.Fatalf("%s did not emit JSON", command[0])
		}
		for _, secret := range []string{"private-password", "private-at", "private-rt", "private-new-at", "private-new-rt"} {
			if strings.Contains(stdout.String()+stderr.String(), secret) {
				t.Fatal("CLI disclosed authentication material")
			}
		}
		if command[0] == "import" && (logins.Load() != 0 || refreshes.Load() != 0) {
			t.Fatal("import unexpectedly contacted the site")
		}
	}
	if logins.Load() != 1 || refreshes.Load() != 1 {
		t.Fatal("run did not perform exactly one login/refresh")
	}
}

func TestCLIHelpAndValidation(t *testing.T) {
	t.Setenv("CERIUM_WEBHOOK_URL", "https://receiver.invalid/private-webhook-token")
	for _, args := range [][]string{{"help"}, {"-h"}, {"run", "-h"}, {"import", "-h"}} {
		var out bytes.Buffer
		if err := run(context.Background(), args, strings.NewReader(""), &out, &out); err != nil || !strings.Contains(out.String(), "Sub2API") {
			t.Fatalf("help failed: %v", err)
		}
		if strings.Contains(out.String(), "private-webhook-token") {
			t.Fatal("help disclosed the configured webhook URL")
		}
	}
	for _, args := range [][]string{{"unknown"}, {"run", "unexpected"}, {"run", "-request-timeout", "0s"}, {"remove"}, {"run", "-unknown"}} {
		var out bytes.Buffer
		if err := run(context.Background(), args, strings.NewReader(""), &out, &out); err == nil {
			t.Fatalf("invalid command accepted: %v", args)
		}
	}
}
