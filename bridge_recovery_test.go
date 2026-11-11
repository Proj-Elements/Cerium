package cerium

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func recoveryFixture(t *testing.T) (*Bridge, Credential) {
	t.Helper()
	store := testStore(t)
	credential := importCredentials(t, store, testCredential())[0]
	bridge, err := NewBridge(store, "0123456789abcdef0123456789abcdef", &bridgeSink{})
	if err != nil {
		t.Fatal(err)
	}
	var hasState int
	if err := store.db.QueryRow("SELECT COUNT(*) FROM pragma_table_info('bridge_jobs') WHERE name='state'").Scan(&hasState); err != nil {
		t.Fatal(err)
	}
	if hasState == 0 {
		if _, err := store.db.Exec("ALTER TABLE bridge_jobs ADD COLUMN state TEXT NOT NULL DEFAULT 'pending'"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.db.Exec(`CREATE TABLE IF NOT EXISTS model_probe_cleanup (
key_name TEXT PRIMARY KEY,credential_id INTEGER NOT NULL,source TEXT NOT NULL,group_id TEXT NOT NULL,
state TEXT NOT NULL,key_id INTEGER NOT NULL,url TEXT NOT NULL,account TEXT NOT NULL,password TEXT NOT NULL,
access_token TEXT NOT NULL,cookies_json TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS model_probe_refreshes (job_id TEXT PRIMARY KEY,credential_id INTEGER NOT NULL,created_at INTEGER NOT NULL);`); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := store.SaveSession(ctx, credential, Session{AccessToken: "access-private", RefreshToken: "refresh-private", ExpiresAt: time.Now().UTC(), Cookies: []*http.Cookie{{Name: "session", Value: "private-cookie"}}}); err != nil {
		t.Fatal(err)
	}
	result := Result{CredentialID: credential.ID, SiteID: "site-00000000000001", JobID: "job-00000000000001", ConfigRevision: 1, CheckedAt: time.Now().UTC(), Catalog: &Catalog{Groups: []Group{{ID: "one", Name: "one"}}}}
	if err := store.SaveResult(ctx, credential, result); err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(result)
	if _, err := store.db.Exec("INSERT INTO bridge_sites(site_id,credential_id,revision) VALUES(?,?,1)", result.SiteID, credential.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec("INSERT INTO bridge_jobs(id,digest,result,created_at,state) VALUES(?,?,?,?,'pending')", result.JobID, strings.Repeat("a", 64), string(encoded), time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec("INSERT INTO model_probes(credential_id,source,group_id,state,key_name,key_secret,key_id) VALUES(?,'source','1','cleanup','probe','key-private',7)", credential.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec("INSERT INTO model_probe_cleanup(key_name,credential_id,source,group_id,state,key_id,url,account,password,access_token,cookies_json) VALUES('old-key',?,'source','2','cleanup',8,?,'original-account','original-password','original-access','[]')", credential.ID, credential.URL); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec("INSERT INTO model_probe_refreshes(job_id,credential_id,created_at) VALUES('refresh-0000000001',?,?)", credential.ID, time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec("UPDATE sqlite_sequence SET seq=99 WHERE name='credentials'"); err != nil {
		t.Fatal(err)
	}
	return bridge, credential
}

func recoveryCall(t *testing.T, bridge *Bridge, gate *sync.RWMutex, path string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	response := httptest.NewRecorder()
	bridge.recovery(response, request, body, gate)
	timestamp := response.Header().Get("X-Cerium-Timestamp")
	mac := hmac.New(sha256.New, bridge.secret)
	mac.Write([]byte(timestamp + "\n"))
	mac.Write(response.Body.Bytes())
	if timestamp == "" || response.Header().Get("X-Cerium-Signature") != "sha256="+hex.EncodeToString(mac.Sum(nil)) || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("recovery response is not authenticated or cache safe")
	}
	return response
}

func TestWorkerRecoveryRoundTripAndValidation(t *testing.T) {
	bridge, credential := recoveryFixture(t)
	var gate sync.RWMutex
	exported := recoveryCall(t, bridge, &gate, "/v1/recovery/export", []byte("{}"))
	if exported.Code != http.StatusOK || !bytes.Contains(exported.Body.Bytes(), []byte("refresh-private")) || !bytes.Contains(exported.Body.Bytes(), []byte("original-password")) {
		t.Fatal("recovery omitted durable private state")
	}
	var archive recoveryArchive
	if err := decodeRecovery(exported.Body.Bytes(), &archive); err != nil || len(archive.Tables) != len(recoveryTables) {
		t.Fatal("invalid exported archive")
	}
	if _, exists := archive.Tables["leases"]; exists {
		t.Fatal("live locks were included in recovery")
	}
	if _, err := bridge.store.db.Exec("UPDATE credentials SET name='changed'; INSERT INTO leases(credential_id,owner,expires_at) VALUES(?,'live',?)", credential.ID, time.Now().Add(time.Hour).Unix()); err != nil {
		t.Fatal(err)
	}
	validated := recoveryCall(t, bridge, &gate, "/v1/recovery/validate", exported.Body.Bytes())
	if validated.Code != http.StatusOK {
		t.Fatalf("valid recovery rejected: %s", validated.Body)
	}
	var name string
	var leases int
	bridge.store.db.QueryRow("SELECT name FROM credentials WHERE id=?", credential.ID).Scan(&name)
	bridge.store.db.QueryRow("SELECT COUNT(*) FROM leases").Scan(&leases)
	if name != "changed" || leases != 1 {
		t.Fatal("validation changed stored data or locks")
	}
	restored := recoveryCall(t, bridge, &gate, "/v1/recovery/import", exported.Body.Bytes())
	if restored.Code != http.StatusOK {
		t.Fatalf("restore failed: %s", restored.Body)
	}
	bridge.store.db.QueryRow("SELECT name FROM credentials WHERE id=?", credential.ID).Scan(&name)
	bridge.store.db.QueryRow("SELECT COUNT(*) FROM leases").Scan(&leases)
	if name != credential.Name || leases != 0 {
		t.Fatal("restore omitted credentials or retained live leases")
	}
	second := recoveryCall(t, bridge, &gate, "/v1/recovery/export", []byte("{}"))
	var after recoveryArchive
	if err := decodeRecovery(second.Body.Bytes(), &after); err != nil {
		t.Fatal(err)
	}
	beforeTables, _ := json.Marshal(archive.Tables)
	afterTables, _ := json.Marshal(after.Tables)
	if !bytes.Equal(beforeTables, afterTables) {
		t.Fatal("round trip changed durable worker tables")
	}
	inserted, err := bridge.store.db.Exec("INSERT INTO credentials(name,url,type,account,password) VALUES('next','https://next.invalid','test','account','password')")
	if err != nil {
		t.Fatal(err)
	}
	if identity, err := inserted.LastInsertId(); err != nil || identity != 100 {
		t.Fatal("recovery reused a deleted credential identity")
	}
}

func TestWorkerRecoveryRejectsInvalidStateAtomically(t *testing.T) {
	bridge, credential := recoveryFixture(t)
	var gate sync.RWMutex
	exported := recoveryCall(t, bridge, &gate, "/v1/recovery/export", []byte("{}"))
	for _, mode := range []string{"unknown-table", "column-injection", "integer-type", "foreign-key", "missing-sequence", "bad-cookies", "bad-job", "missing-required"} {
		t.Run(mode, func(t *testing.T) {
			var archive recoveryArchive
			if err := decodeRecovery(exported.Body.Bytes(), &archive); err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "unknown-table":
				archive.Tables["credentials;DROP TABLE credentials"] = archive.Tables["credentials"]
				delete(archive.Tables, "credentials")
			case "column-injection":
				archive.Tables["credentials"].Columns[0] = "id);DROP TABLE credentials"
			case "integer-type":
				archive.Tables["credentials"].Rows[0][0] = "1"
			case "foreign-key":
				archive.Tables["credentials"] = recoveryTable{Columns: archive.Tables["credentials"].Columns, Rows: [][]any{}}
			case "missing-sequence":
				archive.Tables["sqlite_sequence"] = recoveryTable{Columns: archive.Tables["sqlite_sequence"].Columns, Rows: [][]any{}}
			case "bad-cookies":
				for index, column := range archive.Tables["sessions"].Columns {
					if column == "cookies_json" {
						archive.Tables["sessions"].Rows[0][index] = `[null]`
					}
				}
			case "bad-job":
				for index, column := range archive.Tables["bridge_jobs"].Columns {
					if column == "result" {
						archive.Tables["bridge_jobs"].Rows[0][index] = `{}`
					}
				}
			case "missing-required":
				archive.Tables["sqlite_sequence"].Rows[0][1] = nil
			}
			body, _ := json.Marshal(archive)
			response := recoveryCall(t, bridge, &gate, "/v1/recovery/import", body)
			if response.Code != http.StatusBadRequest || bytes.Contains(response.Body.Bytes(), []byte("private")) {
				t.Fatalf("invalid state accepted or error leaked credentials: %s", response.Body)
			}
			var name string
			if err := bridge.store.db.QueryRow("SELECT name FROM credentials WHERE id=?", credential.ID).Scan(&name); err != nil || name != credential.Name {
				t.Fatal("invalid restore partially replaced live data")
			}
		})
	}
}

func TestWorkerRecoveryRejectsBusyAndMalformedRequests(t *testing.T) {
	bridge, _ := recoveryFixture(t)
	var gate sync.RWMutex
	gate.RLock()
	response := recoveryCall(t, bridge, &gate, "/v1/recovery/export", []byte("{}"))
	gate.RUnlock()
	if response.Code != http.StatusServiceUnavailable {
		t.Fatal("recovery interrupted an active worker")
	}
	for _, body := range []string{`{"unexpected":true}`, `{} {}`, `null`, `[]`} {
		response := recoveryCall(t, bridge, &gate, "/v1/recovery/import", []byte(body))
		if response.Code != http.StatusBadRequest {
			t.Fatal("malformed recovery request accepted")
		}
	}
	if response := recoveryCall(t, bridge, &gate, "/v1/recovery/export", []byte(`null`)); response.Code != http.StatusBadRequest {
		t.Fatal("null export request accepted")
	}
}
