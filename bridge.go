package cerium

import (
	"cerium/contracts"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

type BridgeJob = contracts.BridgeJob

type Bridge struct {
	store       *Store
	sink        Sink
	secret      []byte
	mu          sync.Mutex
	activity    sync.RWMutex
	slots       chan struct{}
	activeSites map[string]bool
	activeJobs  map[string]bool
	maintenance sync.Mutex
}

func NewBridge(store *Store, secret string, sink Sink) (*Bridge, error) {
	if len(secret) < 32 || sink == nil {
		return nil, errors.New("bridge requires a 32+ character secret and a result webhook")
	}
	_, err := store.db.Exec(`CREATE TABLE IF NOT EXISTS bridge_sites (
	 site_id TEXT PRIMARY KEY, credential_id INTEGER UNIQUE REFERENCES credentials(id) ON DELETE SET NULL,
	 revision INTEGER NOT NULL);
	 CREATE TABLE IF NOT EXISTS bridge_jobs (id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL);`)
	if err != nil {
		return nil, err
	}
	var hasState bool
	rows, err := store.db.Query("PRAGMA table_info(bridge_jobs)")
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var position, required, primary int
		var name, kind string
		var defaultValue any
		if err = rows.Scan(&position, &name, &kind, &required, &defaultValue, &primary); err != nil {
			rows.Close()
			return nil, err
		}
		hasState = hasState || name == "state"
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	if !hasState {
		if _, err = store.db.Exec("ALTER TABLE bridge_jobs ADD COLUMN state TEXT NOT NULL DEFAULT 'pending'"); err != nil {
			return nil, err
		}
	}
	concurrency := 4
	if value, parseErr := strconv.Atoi(os.Getenv("CERIUM_BRIDGE_CONCURRENCY")); parseErr == nil && value >= 1 && value <= 32 {
		concurrency = value
	}
	bridge := &Bridge{store: store, sink: sink, secret: []byte(secret), slots: make(chan struct{}, concurrency), activeSites: make(map[string]bool), activeJobs: make(map[string]bool)}
	return bridge, bridge.pruneResults(context.Background())
}

func (b *Bridge) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if r.URL.Path == "/healthz" && r.Method == http.MethodGet {
		io.WriteString(w, `{"ok":true}`)
		return
	}
	if r.URL.Path == "/readyz" && r.Method == http.MethodGet {
		b.readiness(w, r)
		return
	}
	if r.Method != http.MethodPost || (r.URL.Path != "/v1/sync" && r.URL.Path != "/v1/recovery/export" && r.URL.Path != "/v1/recovery/import" && r.URL.Path != "/v1/recovery/validate") {
		http.NotFound(w, r)
		return
	}
	maxBody := int64(1 << 20)
	if strings.HasPrefix(r.URL.Path, "/v1/recovery/") {
		maxBody = maxRecoveryBytes
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	timestamp := r.Header.Get("X-Cerium-Timestamp")
	t, terr := strconv.ParseInt(timestamp, 10, 64)
	mac := hmac.New(sha256.New, b.secret)
	mac.Write([]byte(timestamp + "\n"))
	if strings.HasPrefix(r.URL.Path, "/v1/recovery/") {
		mac.Write([]byte(r.URL.Path + "\n"))
	}
	mac.Write(body)
	signature, serr := hex.DecodeString(strings.TrimPrefix(r.Header.Get("X-Cerium-Signature"), "sha256="))
	if err != nil || terr != nil || serr != nil || t < time.Now().Unix()-300 || t > time.Now().Unix()+300 || !hmac.Equal(signature, mac.Sum(nil)) {
		http.Error(w, `{"error":"invalid signature"}`, http.StatusUnauthorized)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/v1/recovery/") {
		b.recovery(w, r, body, &b.activity)
		return
	}
	var job BridgeJob
	if json.Unmarshal(body, &job) != nil || contracts.ValidateBridgeJob(&job) != nil {
		b.respondError(w, 400, "invalid_job", "validate_job", "")
		return
	}
	if !b.activity.TryRLock() {
		b.respondError(w, 503, "worker_busy", "recovery", job.JobID)
		return
	}
	defer b.activity.RUnlock()
	b.mu.Lock()
	if b.activeSites[job.SiteID] || b.activeJobs[job.JobID] {
		b.mu.Unlock()
		b.respondError(w, 503, "site_busy", "queue", job.JobID)
		return
	}
	select {
	case b.slots <- struct{}{}:
		b.activeSites[job.SiteID], b.activeJobs[job.JobID] = true, true
		b.mu.Unlock()
	default:
		b.mu.Unlock()
		b.respondError(w, 503, "worker_busy", "queue", job.JobID)
		return
	}
	defer func() {
		b.mu.Lock()
		delete(b.activeSites, job.SiteID)
		delete(b.activeJobs, job.JobID)
		<-b.slots
		b.mu.Unlock()
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
	defer cancel()
	digest := sha256.Sum256(body)
	hash := hex.EncodeToString(digest[:])
	var previous, previousHash, state string
	err = b.store.db.QueryRowContext(ctx, "SELECT digest,result,state FROM bridge_jobs WHERE id=?", job.JobID).Scan(&previousHash, &previous, &state)
	var result Result
	if err == nil {
		if hash != previousHash {
			b.respondError(w, 409, "job_identity_conflict", "validate_job", job.JobID)
			return
		}
		if state == "delivered" {
			io.WriteString(w, `{"delivered":true}`)
			return
		}
		if state == "rejected" || state == "expired" {
			b.respondError(w, 422, "callback_rejected", "callback", job.JobID)
			return
		}
		if json.Unmarshal([]byte(previous), &result) != nil {
			b.respondError(w, 500, "invalid_saved_result", "read_result", job.JobID)
			return
		}
	} else if errors.Is(err, sql.ErrNoRows) {
		var retained int
		if err := b.store.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM bridge_jobs").Scan(&retained); err != nil {
			b.respondError(w, 500, "result_read_failed", "read_result", job.JobID)
			return
		}
		if retained+cap(b.slots) > 100000 {
			b.respondError(w, 503, "idempotency_capacity", "queue", job.JobID)
			return
		}
		c, err := b.configure(ctx, job)
		if err != nil {
			if errors.Is(err, errSynchronizationBusy) {
				b.respondError(w, 503, "site_busy", "configure_site", job.JobID)
				return
			}
			b.respondError(w, 409, "site_configuration_conflict", "configure_site", job.JobID)
			return
		}
		result = Result{CheckedAt: time.Now().UTC(), Refresh: "not_attempted", URL: c.URL, Type: c.Type, Name: c.Name}
		if job.Operation == "sync" {
			if job.RefreshModels {
				if err := b.store.RefreshModelProbesForJob(ctx, c.ID, job.JobID); err != nil {
					if errors.Is(err, errSynchronizationBusy) {
						b.respondError(w, 503, "site_busy", "model_discovery", job.JobID)
						return
					}
					b.respondError(w, 409, "model_refresh_conflict", "model_discovery", job.JobID)
					return
				}
			}
			s := Syncer{Store: b.store}
			var runErr error
			result, runErr = s.syncOne(ctx, c, PublicProviders(), 20*time.Second, 2*time.Minute)
			if runErr != nil {
				result.Error = runErr.Error()
			}
		}
		result.SiteID, result.JobID, result.ConfigRevision = job.SiteID, job.JobID, job.Revision
		encoded, encodeErr := json.Marshal(result)
		if encodeErr != nil {
			b.respondError(w, 500, "result_encoding_failed", "persist_result", job.JobID)
			return
		}
		if len(encoded) > 8<<20 {
			if _, err = b.store.db.ExecContext(ctx, "INSERT INTO bridge_jobs(id,digest,result,created_at,state) VALUES(?,?,'',?,'rejected')", job.JobID, hash, time.Now().Unix()); err != nil {
				b.respondError(w, 500, "cannot_persist_rejection", "persist_result", job.JobID)
				return
			}
			b.respondError(w, 422, "result_too_large", "persist_result", job.JobID)
			return
		}
		if _, err = b.store.db.ExecContext(ctx, "INSERT INTO bridge_jobs(id,digest,result,created_at,state) VALUES(?,?,?,?,'pending')", job.JobID, hash, string(encoded), time.Now().Unix()); err != nil {
			b.respondError(w, 500, "result_persist_failed", "persist_result", job.JobID)
			return
		}
		if err = b.pruneResults(ctx); err != nil {
			b.respondError(w, 500, "result_retention_failed", "persist_result", job.JobID)
			return
		}
	} else {
		b.respondError(w, 500, "result_read_failed", "read_result", job.JobID)
		return
	}
	// Redelivery uses the saved result; a lost callback must not rotate tokens again.
	if err := b.sink.Publish(ctx, result); err != nil {
		var rejection *WebhookError
		if errors.As(err, &rejection) && rejection.permanent() {
			if _, persistErr := b.store.db.ExecContext(ctx, "UPDATE bridge_jobs SET result='',state='rejected' WHERE id=?", job.JobID); persistErr != nil {
				b.respondError(w, 500, "callback_rejection_persist_failed", "callback", job.JobID)
				return
			}
			b.respondError(w, 422, "callback_rejected", "callback", job.JobID)
			return
		}
		b.respondError(w, 502, "callback_unavailable", "callback", job.JobID)
		return
	}
	if _, err := b.store.db.ExecContext(ctx, "UPDATE bridge_jobs SET result='',state='delivered' WHERE id=?", job.JobID); err != nil {
		b.respondError(w, 500, "delivery_persist_failed", "callback", job.JobID)
		return
	}
	io.WriteString(w, `{"delivered":true}`)
}

func (b *Bridge) respondError(w http.ResponseWriter, status int, code, stage, jobID string) {
	slog.Warn("bridge request failed", "code", code, "stage", stage, "job_id", jobID, "status", status)
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{"error": code, "code": code, "stage": stage, "job_id": jobID})
}

func (b *Bridge) pruneResults(ctx context.Context) error {
	tx, err := b.store.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, "DELETE FROM bridge_jobs WHERE created_at<?", time.Now().Add(-30*24*time.Hour).Unix()); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM bridge_jobs WHERE state='delivered' AND created_at<?", time.Now().Add(-time.Hour).Unix()); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM model_probe_refreshes WHERE created_at<?", time.Now().Add(-30*24*time.Hour).Unix()); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE bridge_jobs SET result='',state='expired' WHERE state='pending' AND created_at<?", time.Now().Add(-24*time.Hour).Unix()); err != nil {
		return err
	}
	var total int64
	if err = tx.QueryRowContext(ctx, "SELECT COALESCE(SUM(length(CAST(result AS BLOB))),0) FROM bridge_jobs").Scan(&total); err != nil {
		return err
	}
	for total > 64<<20 {
		var jobID string
		var size int64
		if err = tx.QueryRowContext(ctx, "SELECT id,length(CAST(result AS BLOB)) FROM bridge_jobs WHERE length(result)>0 ORDER BY created_at,id LIMIT 1").Scan(&jobID, &size); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "UPDATE bridge_jobs SET result='',state='expired' WHERE id=?", jobID); err != nil {
			return err
		}
		total -= size
	}
	return tx.Commit()
}

func (b *Bridge) readiness(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := b.store.db.PingContext(ctx); err != nil {
		b.respondError(w, 503, "database_unavailable", "readiness", "")
		return
	}
	var pending, stale int
	if err := b.store.db.QueryRowContext(ctx, "SELECT COUNT(*),COALESCE(SUM(created_at<?),0) FROM bridge_jobs WHERE state='pending'", time.Now().Add(-15*time.Minute).Unix()).Scan(&pending, &stale); err != nil {
		b.respondError(w, 503, "queue_unavailable", "readiness", "")
		return
	}
	var cleanupPending, cleanupFailed int
	if err := b.store.db.QueryRowContext(ctx, "SELECT COUNT(*),COALESCE(SUM(attempts>0),0) FROM model_probe_cleanup").Scan(&cleanupPending, &cleanupFailed); err != nil {
		b.respondError(w, 503, "cleanup_queue_unavailable", "readiness", "")
		return
	}
	b.mu.Lock()
	active, capacity := len(b.activeJobs), cap(b.slots)
	b.mu.Unlock()
	status := http.StatusOK
	if stale > 0 {
		status = http.StatusServiceUnavailable
	}
	solver := map[string]any{"configured": false, "ready": false, "capacity_available": false}
	if solverURL := os.Getenv("CERIUM_TURNSTILE_SOLVER_URL"); solverURL != "" {
		solver["configured"] = true
		if client, err := newAPIClientWithTransport(solverURL, time.Second, true); err == nil {
			data, code, requestErr := client.rawRequest(ctx, &Session{}, http.MethodGet, "/readyz", nil, requestOptions{noRetry: true})
			var readiness struct {
				Ready    bool `json:"ok"`
				Active   int  `json:"active_tasks"`
				Capacity int  `json:"capacity"`
			}
			if requestErr == nil && code == http.StatusOK && json.Unmarshal(data, &readiness) == nil {
				solver["ready"] = readiness.Ready
				solver["capacity_available"] = readiness.Ready && readiness.Active < readiness.Capacity
			}
		}
	}
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{"ok": status == http.StatusOK, "database": "ready", "active_jobs": active, "capacity": capacity, "pending_callbacks": pending, "stale_callbacks": stale, "pending_model_cleanup": cleanupPending, "failed_model_cleanup": cleanupFailed, "solver": solver})
}

// Maintain retries one retained cleanup item and bounds callback-cache storage.
func (b *Bridge) Maintain(ctx context.Context) error {
	if !b.maintenance.TryLock() {
		return nil
	}
	defer b.maintenance.Unlock()
	if !b.activity.TryRLock() {
		return nil
	}
	defer b.activity.RUnlock()
	return errors.Join(b.store.RetryProbeCleanup(ctx), b.pruneResults(ctx))
}

func (b *Bridge) configure(ctx context.Context, j BridgeJob) (Credential, error) {
	c := Credential{Name: j.Name, URL: j.URL, Type: j.Type, Account: strings.TrimSpace(j.Account), Password: j.Password, AccessToken: j.AccessToken, UserID: j.UserID}
	if j.Operation == "sync" {
		u, err := parseBaseURL(j.URL)
		if err != nil {
			return c, err
		}
		c.URL = u.String()
		if (j.Type != "sub2api" && j.Type != "newapi") || normalizeAuth(&c) != nil {
			return c, errors.New("invalid credential")
		}
	}
	tx, err := b.store.db.BeginTx(ctx, nil)
	if err != nil {
		return c, err
	}
	defer tx.Rollback()
	var oldID sql.NullInt64
	var revision int64
	err = tx.QueryRowContext(ctx, "SELECT credential_id,revision FROM bridge_sites WHERE site_id=?", j.SiteID).Scan(&oldID, &revision)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return c, err
	}
	if revision > j.Revision {
		return c, errors.New("stale revision")
	}
	if j.Operation == "delete" {
		if oldID.Valid {
			if err = credentialIdle(ctx, tx, oldID.Int64); err != nil {
				return c, err
			}
			if err = retainProbeCleanup(ctx, tx, oldID.Int64); err != nil {
				return c, err
			}
			if _, err = tx.ExecContext(ctx, "DELETE FROM credentials WHERE id=?", oldID.Int64); err != nil {
				return c, err
			}
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO bridge_sites VALUES(?,NULL,?) ON CONFLICT(site_id) DO UPDATE SET credential_id=NULL,revision=excluded.revision`, j.SiteID, j.Revision)
	} else if oldID.Valid {
		c.ID = oldID.Int64
		var old Credential
		err = tx.QueryRowContext(ctx, "SELECT url,type,account,password,access_token,user_id,revision FROM credentials WHERE id=?", c.ID).Scan(&old.URL, &old.Type, &old.Account, &old.Password, &old.AccessToken, &old.UserID, &c.Revision)
		if err != nil {
			return c, err
		}
		if old.URL != c.URL || old.Type != c.Type || old.Account != c.Account || old.Password != c.Password || old.AccessToken != c.AccessToken || old.UserID != c.UserID {
			if err = credentialIdle(ctx, tx, c.ID); err != nil {
				return c, err
			}
			if err = retainProbeCleanup(ctx, tx, c.ID); err != nil {
				return c, err
			}
			c.Revision++
			if _, err = tx.ExecContext(ctx, "DELETE FROM sessions WHERE credential_id=?", c.ID); err != nil {
				return c, err
			}
			if _, err = tx.ExecContext(ctx, "DELETE FROM snapshots WHERE credential_id=?", c.ID); err != nil {
				return c, err
			}
		}
		_, err = tx.ExecContext(ctx, "UPDATE credentials SET name=?,url=?,type=?,account=?,password=?,access_token=?,user_id=?,revision=? WHERE id=?", c.Name, c.URL, c.Type, c.Account, c.Password, c.AccessToken, c.UserID, c.Revision, c.ID)
		if err == nil {
			_, err = tx.ExecContext(ctx, "UPDATE bridge_sites SET revision=? WHERE site_id=?", j.Revision, j.SiteID)
		}
	} else {
		c.Revision = 1
		res, insertErr := tx.ExecContext(ctx, "INSERT INTO credentials(name,url,type,account,password,access_token,user_id) VALUES(?,?,?,?,?,?,?)", c.Name, c.URL, c.Type, c.Account, c.Password, c.AccessToken, c.UserID)
		if insertErr != nil {
			return c, insertErr
		}
		c.ID, err = res.LastInsertId()
		if err == nil {
			_, err = tx.ExecContext(ctx, `INSERT INTO bridge_sites VALUES(?,?,?) ON CONFLICT(site_id) DO UPDATE SET credential_id=excluded.credential_id,revision=excluded.revision`, j.SiteID, c.ID, j.Revision)
		}
	}
	if err != nil {
		return c, err
	}
	return c, tx.Commit()
}
