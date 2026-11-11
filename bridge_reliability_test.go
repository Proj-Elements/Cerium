package cerium

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const bridgeTestSecret = "0123456789abcdef0123456789abcdef"

func postBridgeJob(t *testing.T, bridge *Bridge, job BridgeJob) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(job)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/sync", bytes.NewReader(body))
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, []byte(bridgeTestSecret))
	mac.Write([]byte(timestamp + "\n"))
	mac.Write(body)
	request.Header.Set("X-Cerium-Timestamp", timestamp)
	request.Header.Set("X-Cerium-Signature", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	recorder := httptest.NewRecorder()
	bridge.ServeHTTP(recorder, request)
	return recorder
}

func TestBridgeRejectsPermanentCallbacksWithoutPoisoningManualRecollection(t *testing.T) {
	store := testStore(t)
	var collections atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/api/user/self/groups" {
			reply(response, `{"success":true,"data":{}}`)
			return
		}
		if request.URL.Path != "/api/pricing" {
			t.Errorf("unexpected path %s", request.URL.Path)
		}
		collections.Add(1)
		reply(response, `{"success":true,"usable_group":{"default":"Public"},"group_ratio":{"default":1},"data":[]}`)
	}))
	defer upstream.Close()
	var reject atomic.Bool
	reject.Store(true)
	sink := sinkFunc(func(context.Context, Result) error {
		if reject.Load() {
			return &WebhookError{Status: http.StatusBadRequest}
		}
		return nil
	})
	bridge, err := NewBridge(store, bridgeTestSecret, sink)
	if err != nil {
		t.Fatal(err)
	}
	job := BridgeJob{JobID: "job-00000000000001", SiteID: "site-00000000000001", Revision: 1, Operation: "sync", Name: "Site", URL: upstream.URL, Type: "newapi", AccessToken: "token", UserID: 1}
	if response := postBridgeJob(t, bridge, job); response.Code != 422 || !strings.Contains(response.Body.String(), "callback_rejected") {
		t.Fatal(response.Code, response.Body.String())
	}
	var state, result string
	if err := store.db.QueryRow("SELECT state,result FROM bridge_jobs WHERE id=?", job.JobID).Scan(&state, &result); err != nil || state != "rejected" || result != "" {
		t.Fatal("invalid permanent callback state", err)
	}
	reject.Store(false)
	if response := postBridgeJob(t, bridge, job); response.Code != 422 {
		t.Fatal("rejected job was rerun", response.Code)
	}
	if collections.Load() != 1 {
		t.Fatal("automatic recollection repeated")
	}
	job.JobID = "job-00000000000002"
	if response := postBridgeJob(t, bridge, job); response.Code != 200 {
		t.Fatal("manual recollection failed", response.Code, response.Body.String())
	}
	if collections.Load() != 2 {
		t.Fatal("manual retry did not recollect")
	}
	if err := store.db.QueryRow("SELECT state,result FROM bridge_jobs WHERE id=?", job.JobID).Scan(&state, &result); err != nil || state != "delivered" || result != "" {
		t.Fatal("delivered blob retained", err)
	}
	if response := postBridgeJob(t, bridge, job); response.Code != 200 || collections.Load() != 2 {
		t.Fatal("delivered job not idempotent")
	}
}

func TestBridgeProcessesDifferentSitesConcurrentlyAndSerializesSite(t *testing.T) {
	store := testStore(t)
	entered := make(chan struct{}, 2)
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/api/user/self/groups" {
			reply(response, `{"success":true,"data":{}}`)
			return
		}
		entered <- struct{}{}
		<-release
		reply(response, `{"success":true,"usable_group":{},"group_ratio":{},"data":[]}`)
	}))
	defer upstream.Close()
	bridge, err := NewBridge(store, bridgeTestSecret, sinkFunc(func(context.Context, Result) error { return nil }))
	if err != nil {
		t.Fatal(err)
	}
	first := BridgeJob{JobID: "job-00000000000001", SiteID: "site-00000000000001", Revision: 1, Operation: "sync", Name: "First", URL: upstream.URL, Type: "newapi", AccessToken: "token", UserID: 1}
	second := first
	second.JobID, second.SiteID, second.UserID = "job-00000000000002", "site-00000000000002", 2
	responses := make(chan *httptest.ResponseRecorder, 2)
	go func() { responses <- postBridgeJob(t, bridge, first) }()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		close(release)
		t.Fatal("first site did not start")
	}
	duplicate := first
	duplicate.JobID = "job-00000000000003"
	if response := postBridgeJob(t, bridge, duplicate); response.Code != 503 {
		close(release)
		t.Fatal("same-site job overlapped", response.Code)
	}
	go func() { responses <- postBridgeJob(t, bridge, second) }()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		close(release)
		t.Fatal("unrelated site blocked")
	}
	close(release)
	for count := 0; count < 2; count++ {
		if response := <-responses; response.Code != 200 {
			t.Fatal(response.Code, response.Body.String())
		}
	}
}

func TestBridgeCapacityPreservesRetainedJobIdentities(t *testing.T) {
	store := testStore(t)
	bridge, err := NewBridge(store, bridgeTestSecret, sinkFunc(func(context.Context, Result) error { return nil }))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`WITH RECURSIVE counter(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM counter WHERE value<100000)
INSERT INTO bridge_jobs(id,digest,result,created_at,state) SELECT 'retained-'||value,'digest','',?,'expired' FROM counter`, time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
	if err := bridge.pruneResults(context.Background()); err != nil {
		t.Fatal(err)
	}
	var retained int
	if err := store.db.QueryRow("SELECT COUNT(*) FROM bridge_jobs").Scan(&retained); err != nil || retained != 100000 {
		t.Fatal("retained identity evicted", retained, err)
	}
	job := BridgeJob{JobID: "job-00000000000001", SiteID: "site-00000000000001", Revision: 1, Operation: "delete", Type: "others"}
	response := postBridgeJob(t, bridge, job)
	if response.Code != 503 || !strings.Contains(response.Body.String(), "idempotency_capacity") {
		t.Fatal(response.Code, response.Body.String())
	}
	if err := store.db.QueryRow("SELECT COUNT(*) FROM bridge_sites").Scan(&retained); err != nil || retained != 0 {
		t.Fatal("capacity rejection had side effects", retained, err)
	}
}

func TestCredentialMutationPathsRetainModelCleanup(t *testing.T) {
	for _, change := range []string{"remove", "import", "bridge-delete", "bridge-auth"} {
		t.Run(change, func(t *testing.T) {
			store := testStore(t)
			credential := importCredentials(t, store, Credential{URL: "https://example.invalid", Type: "sub2api", Account: "original", Password: "password"})[0]
			if err := store.SaveSession(context.Background(), credential, Session{AccessToken: "original-panel"}); err != nil {
				t.Fatal(err)
			}
			if _, err := store.db.Exec("INSERT INTO model_probes VALUES(?,'source','1','cleanup','temporary-probe','temporary-key',9,NULL,'','')", credential.ID); err != nil {
				t.Fatal(err)
			}
			bridge, err := NewBridge(store, bridgeTestSecret, sinkFunc(func(context.Context, Result) error { return nil }))
			if err != nil {
				t.Fatal(err)
			}
			job := BridgeJob{JobID: "job-00000000000001", SiteID: "site-00000000000001", Revision: 2, Operation: "sync", Name: "Site", URL: credential.URL, Type: credential.Type, Account: credential.Account, Password: "changed"}
			switch change {
			case "remove":
				err = store.Remove(context.Background(), credential.ID)
			case "import":
				_, err = store.Import(context.Background(), strings.NewReader(`{"credentials":[{"url":"https://example.invalid","type":"sub2api","account":"original","password":"changed"}]}`))
			default:
				if _, err = store.db.Exec("INSERT INTO bridge_sites VALUES(?,?,1)", job.SiteID, credential.ID); err != nil {
					t.Fatal(err)
				}
				if change == "bridge-delete" {
					job.Operation = "delete"
				}
				_, err = bridge.configure(context.Background(), job)
			}
			if err != nil {
				t.Fatal(err)
			}
			var account, password, accessToken string
			if err := store.db.QueryRow("SELECT account,password,access_token FROM model_probe_cleanup WHERE key_name='temporary-probe'").Scan(&account, &password, &accessToken); err != nil || account != "original" || password != "password" || accessToken != "original-panel" {
				t.Fatal("mutation lost original cleanup credentials", err)
			}
		})
	}
}

func TestBridgePrunesDeliveredHistoryWithoutRemovingFailedIdentities(t *testing.T) {
	store := testStore(t)
	bridge, err := NewBridge(store, bridgeTestSecret, sinkFunc(func(context.Context, Result) error { return nil }))
	if err != nil {
		t.Fatal(err)
	}
	for _, state := range []string{"delivered", "pending", "rejected", "expired"} {
		if _, err := store.db.Exec("INSERT INTO bridge_jobs(id,digest,result,created_at,state) VALUES(?,?,'',?,?)", state, "digest", time.Now().Add(-2*time.Hour).Unix(), state); err != nil {
			t.Fatal(err)
		}
	}
	if err := bridge.pruneResults(context.Background()); err != nil {
		t.Fatal(err)
	}
	var retained int
	if err := store.db.QueryRow("SELECT COUNT(*) FROM bridge_jobs").Scan(&retained); err != nil || retained != 3 {
		t.Fatal("failed identities lost or delivered history unbounded", retained, err)
	}
	if err := store.db.QueryRow("SELECT COUNT(*) FROM bridge_jobs WHERE state='delivered'").Scan(&retained); err != nil || retained != 0 {
		t.Fatal("delivered history retained", retained, err)
	}
}

func TestBridgeRecoverySignatureBindsRouteAndCompressedResponse(t *testing.T) {
	store := testStore(t)
	bridge, err := NewBridge(store, bridgeTestSecret, sinkFunc(func(context.Context, Result) error { return nil }))
	if err != nil {
		t.Fatal(err)
	}
	requestFor := func(signedPath, requestedPath string) *httptest.ResponseRecorder {
		body := []byte(`{}`)
		request := httptest.NewRequest(http.MethodPost, requestedPath, bytes.NewReader(body))
		timestamp := strconv.FormatInt(time.Now().Unix(), 10)
		mac := hmac.New(sha256.New, []byte(bridgeTestSecret))
		mac.Write([]byte(timestamp + "\n" + signedPath + "\n"))
		mac.Write(body)
		request.Header.Set("X-Cerium-Timestamp", timestamp)
		request.Header.Set("X-Cerium-Signature", "sha256="+hex.EncodeToString(mac.Sum(nil)))
		request.Header.Set("Accept-Encoding", "gzip")
		response := httptest.NewRecorder()
		bridge.ServeHTTP(response, request)
		return response
	}
	if response := requestFor("/v1/recovery/validate", "/v1/recovery/import"); response.Code != http.StatusUnauthorized {
		t.Fatal("recovery signature replayed on another route", response.Code)
	}
	response := requestFor("/v1/recovery/export", "/v1/recovery/export")
	if response.Code != http.StatusOK || response.Header().Get("Content-Encoding") != "gzip" {
		t.Fatal("signed gzip export failed", response.Code, response.Body.String())
	}
	reader, err := gzip.NewReader(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := io.ReadAll(reader)
	reader.Close()
	if err != nil {
		t.Fatal(err)
	}
	mac := hmac.New(sha256.New, []byte(bridgeTestSecret))
	mac.Write([]byte(response.Header().Get("X-Cerium-Timestamp") + "\n"))
	mac.Write(decoded)
	if response.Header().Get("X-Cerium-Signature") != "sha256="+hex.EncodeToString(mac.Sum(nil)) {
		t.Fatal("decompressed archive signature invalid")
	}
}

func TestBridgeRetentionBoundsBytesAndReadinessDetectsCallbackStall(t *testing.T) {
	store := testStore(t)
	bridge, err := NewBridge(store, bridgeTestSecret, sinkFunc(func(context.Context, Result) error { return nil }))
	if err != nil {
		t.Fatal(err)
	}
	payload := strings.Repeat("x", 8<<20)
	for index := 0; index < 9; index++ {
		if _, err := store.db.Exec("INSERT INTO bridge_jobs(id,digest,result,created_at,state) VALUES(?,?,?,?,'pending')", strconv.Itoa(index), "digest", payload, time.Now().Add(-time.Minute).Unix()+int64(index)); err != nil {
			t.Fatal(err)
		}
	}
	if err := bridge.pruneResults(context.Background()); err != nil {
		t.Fatal(err)
	}
	var size int64
	if err := store.db.QueryRow("SELECT SUM(length(CAST(result AS BLOB))) FROM bridge_jobs").Scan(&size); err != nil || size > 64<<20 {
		t.Fatal("result bytes unbounded", size, err)
	}
	if _, err := store.db.Exec("UPDATE bridge_jobs SET created_at=? WHERE state='pending'", time.Now().Add(-time.Hour).Unix()); err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	bridge.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if response.Code != 503 || !strings.Contains(response.Body.String(), `"stale_callbacks":8`) {
		t.Fatal(response.Code, response.Body.String())
	}
}
