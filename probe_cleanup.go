package cerium

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

const probeCleanupSchema = `
CREATE TABLE IF NOT EXISTS model_probe_cleanup (
  key_name TEXT PRIMARY KEY,
  credential_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  group_id TEXT NOT NULL,
  state TEXT NOT NULL,
  key_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  account TEXT NOT NULL,
  password TEXT NOT NULL,
  access_token TEXT NOT NULL,
  cookies_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS model_probe_refreshes (
  job_id TEXT PRIMARY KEY,
  credential_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);`

func retainProbeCleanup(ctx context.Context, tx *sql.Tx, credentialID int64) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO model_probe_cleanup
(key_name,credential_id,source,group_id,state,key_id,url,account,password,access_token,cookies_json)
SELECT p.key_name,p.credential_id,p.source,p.group_id,
CASE WHEN p.state='creating' THEN 'creating' ELSE 'cleanup' END,p.key_id,
c.url,c.account,c.password,COALESCE(s.access_token,''),COALESCE(s.cookies_json,'[]')
FROM model_probes p JOIN credentials c ON c.id=p.credential_id
LEFT JOIN sessions s ON s.credential_id=c.id
WHERE c.id=? AND p.state!='done'
ON CONFLICT(key_name) DO NOTHING`, credentialID)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "DELETE FROM model_probes WHERE credential_id=? AND state!='done'", credentialID)
	return err
}

type pendingProbeCleanup struct {
	Name, Source, GroupID, State string
	Credential                   Credential
	Session                      Session
	KeyID                        int64
	Attempts                     int
}

// RetryProbeCleanup retries at most one due deletion using the original site's
// credentials. Its independent queue survives credential removal and never
// repeats a gateway model request or a temporary-key creation.
func (s *Store) RetryProbeCleanup(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var pending pendingProbeCleanup
	var cookies string
	err := s.db.QueryRowContext(ctx, `SELECT key_name,credential_id,source,group_id,state,key_id,
url,account,password,access_token,cookies_json,attempts FROM model_probe_cleanup
WHERE next_attempt_at<=? ORDER BY next_attempt_at,key_name LIMIT 1`, time.Now().Unix()).Scan(
		&pending.Name, &pending.Credential.ID, &pending.Source, &pending.GroupID, &pending.State, &pending.KeyID,
		&pending.Credential.URL, &pending.Credential.Account, &pending.Credential.Password,
		&pending.Session.AccessToken, &cookies, &pending.Attempts)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return errors.New("cannot read pending model-key cleanup")
	}
	claim, err := s.db.ExecContext(ctx, `UPDATE model_probe_cleanup SET next_attempt_at=?
WHERE key_name=? AND next_attempt_at<=?`, time.Now().Add(30*time.Second).Unix(), pending.Name, time.Now().Unix())
	if err != nil {
		return errors.New("cannot claim pending model-key cleanup")
	}
	claimed, err := claim.RowsAffected()
	if err != nil || claimed == 0 {
		return err
	}
	if json.Unmarshal([]byte(cookies), &pending.Session.Cookies) != nil {
		return errors.New("invalid pending model-key cleanup session")
	}
	pending.Credential.Type = "sub2api"
	provider, err := NewSub2API(pending.Credential, 3*time.Second)
	if err == nil {
		err = s.retryProbeCleanup(ctx, provider.(*sub2API), &pending)
	}
	persistCtx, persistCancel := persistenceContext(ctx)
	defer persistCancel()
	if err == nil {
		_, err = s.db.ExecContext(persistCtx, "DELETE FROM model_probe_cleanup WHERE key_name=?", pending.Name)
		return err
	}
	delay := 30 * time.Second * time.Duration(1<<min(pending.Attempts, 7))
	_, persistErr := s.db.ExecContext(persistCtx, `UPDATE model_probe_cleanup
SET attempts=attempts+1,next_attempt_at=? WHERE key_name=?`, time.Now().Add(delay).Unix(), pending.Name)
	return errors.Join(errors.New("temporary model-key cleanup is pending"), persistErr)
}

func (s *Store) retryProbeCleanup(ctx context.Context, provider *sub2API, pending *pendingProbeCleanup) error {
	if pending.Session.Empty() {
		if err := provider.Login(ctx, &pending.Session); err != nil {
			return err
		}
	}
	request := func(method, route string, options requestOptions) (envelope, error) {
		response, err := provider.client.requestWith(ctx, &pending.Session, method, route, nil, options)
		if authRejected(err) {
			if err = provider.Login(ctx, &pending.Session); err != nil {
				return response, err
			}
			return provider.client.requestWith(ctx, &pending.Session, method, route, nil, options)
		}
		return response, err
	}
	if pending.State == "creating" {
		response, err := request(http.MethodGet, "/api/v1/keys", requestOptions{query: url.Values{"search": {pending.Name}, "page_size": {"100"}}})
		if err != nil {
			return err
		}
		data, err := decodeData[struct {
			Items []probeKey `json:"items"`
			Total int        `json:"total"`
		}](response)
		if err != nil || data.Items == nil {
			return errors.New("cannot reconcile pending model key")
		}
		for _, key := range data.Items {
			if key.ID > 0 && key.Name == pending.Name && strconv.FormatInt(key.GroupID, 10) == pending.GroupID {
				pending.KeyID = key.ID
				break
			}
		}
		if pending.KeyID == 0 {
			if data.Total > len(data.Items) {
				return errors.New("model-key reconciliation is incomplete")
			}
			return nil
		}
		if _, err := s.db.ExecContext(ctx, "UPDATE model_probe_cleanup SET state='cleanup',key_id=? WHERE key_name=?", pending.KeyID, pending.Name); err != nil {
			return err
		}
	}
	if pending.KeyID <= 0 {
		return errors.New("invalid pending model-key identity")
	}
	_, err := request(http.MethodDelete, "/api/v1/keys/"+strconv.FormatInt(pending.KeyID, 10), requestOptions{})
	if hasStatus(err, http.StatusNotFound) {
		return nil
	}
	return err
}

// RefreshModelProbes deliberately forgets completed model discovery. An active
// or unresolved key blocks refreshing that credential until cleanup succeeds.
func (s *Store) RefreshModelProbes(ctx context.Context, credentialID int64) error {
	return s.refreshModelProbes(ctx, credentialID, "")
}

// RefreshModelProbesForJob resets completed discovery once for a durable job
// identity, including after a worker restart before callback persistence.
func (s *Store) RefreshModelProbesForJob(ctx context.Context, credentialID int64, jobID string) error {
	if jobID == "" {
		return errors.New("model refresh job identity is required")
	}
	return s.refreshModelProbes(ctx, credentialID, jobID)
}

func (s *Store) refreshModelProbes(ctx context.Context, credentialID int64, jobID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if jobID != "" {
		var previousCredentialID int64
		err := tx.QueryRowContext(ctx, "SELECT credential_id FROM model_probe_refreshes WHERE job_id=?", jobID).Scan(&previousCredentialID)
		if err == nil {
			if previousCredentialID != credentialID {
				return errors.New("model refresh job identity conflict")
			}
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
	}
	if err := credentialIdle(ctx, tx, credentialID); err != nil {
		return err
	}
	var pending int
	if err := tx.QueryRowContext(ctx, `SELECT
(SELECT count(*) FROM model_probes WHERE credential_id=? AND state!='done')+
(SELECT count(*) FROM model_probe_cleanup WHERE credential_id=?)`, credentialID, credentialID).Scan(&pending); err != nil {
		return err
	}
	if pending != 0 {
		return errors.New("temporary model keys must finish cleanup before refreshing discovery")
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM model_probes WHERE credential_id=? AND state='done'", credentialID); err != nil {
		return err
	}
	if jobID != "" {
		if _, err := tx.ExecContext(ctx, "INSERT INTO model_probe_refreshes VALUES(?,?,?)", jobID, credentialID, time.Now().Unix()); err != nil {
			return err
		}
	}
	return tx.Commit()
}
