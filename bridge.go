package cerium

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

type BridgeJob struct {
	JobID       string `json:"job_id"`
	SiteID      string `json:"site_id"`
	Revision    int64  `json:"config_revision"`
	Operation   string `json:"operation"`
	Name        string `json:"name"`
	URL         string `json:"url"`
	Type        string `json:"type"`
	Account     string `json:"account"`
	Password    string `json:"password"`
	AccessToken string `json:"access_token,omitempty"`
	UserID      int64  `json:"user_id,omitempty"`
}

type Bridge struct {
	store  *Store
	sink   Sink
	secret []byte
	mu     sync.Mutex
}

func NewBridge(store *Store, secret string, sink Sink) (*Bridge, error) {
	if len(secret) < 32 || sink == nil {
		return nil, errors.New("bridge requires a 32+ character secret and a result webhook")
	}
	_, err := store.db.Exec(`CREATE TABLE IF NOT EXISTS bridge_sites (
	 site_id TEXT PRIMARY KEY, credential_id INTEGER UNIQUE REFERENCES credentials(id) ON DELETE SET NULL,
	 revision INTEGER NOT NULL);
	 CREATE TABLE IF NOT EXISTS bridge_jobs (id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL);`)
	return &Bridge{store: store, sink: sink, secret: []byte(secret)}, err
}

func (b *Bridge) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if r.URL.Path == "/healthz" && r.Method == http.MethodGet {
		io.WriteString(w, `{"ok":true}`)
		return
	}
	if r.URL.Path != "/v1/sync" || r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	timestamp := r.Header.Get("X-Cerium-Timestamp")
	t, terr := strconv.ParseInt(timestamp, 10, 64)
	mac := hmac.New(sha256.New, b.secret)
	mac.Write([]byte(timestamp + "\n"))
	mac.Write(body)
	signature, serr := hex.DecodeString(strings.TrimPrefix(r.Header.Get("X-Cerium-Signature"), "sha256="))
	if err != nil || terr != nil || serr != nil || t < time.Now().Unix()-300 || t > time.Now().Unix()+300 || !hmac.Equal(signature, mac.Sum(nil)) {
		http.Error(w, `{"error":"invalid signature"}`, http.StatusUnauthorized)
		return
	}
	var job BridgeJob
	if json.Unmarshal(body, &job) != nil || len(job.JobID) < 16 || len(job.JobID) > 128 || len(job.SiteID) < 16 || len(job.SiteID) > 128 || job.Revision < 1 || (job.Operation != "sync" && job.Operation != "delete") {
		http.Error(w, `{"error":"invalid job"}`, 400)
		return
	}
	if !b.mu.TryLock() {
		http.Error(w, `{"error":"worker busy; retry later"}`, 503)
		return
	}
	defer b.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
	defer cancel()
	digest := sha256.Sum256(body)
	hash := hex.EncodeToString(digest[:])
	var previous, previousHash string
	err = b.store.db.QueryRowContext(ctx, "SELECT digest,result FROM bridge_jobs WHERE id=?", job.JobID).Scan(&previousHash, &previous)
	var result Result
	if err == nil {
		if hash != previousHash {
			http.Error(w, `{"error":"job identity conflict"}`, 409)
			return
		}
		if json.Unmarshal([]byte(previous), &result) != nil {
			http.Error(w, `{"error":"invalid saved job"}`, 500)
			return
		}
	} else if errors.Is(err, sql.ErrNoRows) {
		c, err := b.configure(ctx, job)
		if err != nil {
			http.Error(w, `{"error":"invalid or conflicting site configuration"}`, 409)
			return
		}
		result = Result{CheckedAt: time.Now().UTC(), Refresh: "not_attempted", URL: c.URL, Type: c.Type, Name: c.Name}
		if job.Operation == "sync" {
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
			http.Error(w, `{"error":"cannot encode result"}`, 500)
			return
		}
		if _, err = b.store.db.ExecContext(ctx, "INSERT INTO bridge_jobs VALUES(?,?,?,?)", job.JobID, hash, string(encoded), time.Now().Unix()); err != nil {
			http.Error(w, `{"error":"cannot persist result"}`, 500)
			return
		}
	} else {
		http.Error(w, `{"error":"cannot read saved job"}`, 500)
		return
	}
	// Redelivery uses the saved result; a lost callback must not rotate tokens again.
	if err := b.sink.Publish(ctx, result); err != nil {
		http.Error(w, `{"error":"result callback failed; retry this job"}`, 502)
		return
	}
	b.store.db.ExecContext(ctx, "DELETE FROM bridge_jobs WHERE created_at<?", time.Now().Add(-30*24*time.Hour).Unix())
	io.WriteString(w, `{"delivered":true}`)
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
