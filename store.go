package cerium

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct{ db *sql.DB }

const credentialSchema = `
CREATE TABLE IF NOT EXISTS credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  type TEXT NOT NULL,
  account TEXT NOT NULL,
  password TEXT NOT NULL,
  access_token TEXT NOT NULL DEFAULT '',
  user_id INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  UNIQUE(url, type, account, user_id)
);`

const schema = credentialSchema + `
CREATE TABLE IF NOT EXISTS sessions (
  credential_id INTEGER PRIMARY KEY REFERENCES credentials(id) ON DELETE CASCADE,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  cookies_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
  credential_id INTEGER PRIMARY KEY REFERENCES credentials(id) ON DELETE CASCADE,
  fetched_at TEXT,
  catalog_json TEXT,
  last_run_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS leases (
  credential_id INTEGER PRIMARY KEY REFERENCES credentials(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS model_probes (
  credential_id INTEGER NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  group_id TEXT NOT NULL,
  state TEXT NOT NULL,
  key_name TEXT NOT NULL,
  key_secret TEXT NOT NULL,
  key_id INTEGER NOT NULL DEFAULT 0,
  models_json TEXT,
  fetched_at TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(credential_id,source,group_id)
);`

func OpenStore(filename string) (*Store, error) {
	if filename == "" {
		return nil, errors.New("database filename is required")
	}
	abs, err := filepath.Abs(filename)
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(filepath.Dir(abs), 0700); err != nil {
		return nil, err
	}
	// Pre-create a private database before SQLite can create its journal files.
	f, err := os.OpenFile(abs, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	chmodErr := f.Chmod(0600)
	closeErr := f.Close()
	if err = errors.Join(chmodErr, closeErr); err != nil {
		return nil, err
	}
	u := url.URL{Scheme: "file", Path: abs}
	q := url.Values{"_pragma": {"foreign_keys(1)", "busy_timeout(5000)"}}
	u.RawQuery = q.Encode()
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err = db.ExecContext(ctx, schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("initialize SQLite: %w", err)
	}
	if err = migrateCredentials(ctx, db); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate SQLite credentials: %w", err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// Import upserts by (url, type, account, user_id). Identical imports retain
// sessions; changing a secret invalidates the session and old snapshot.
func (s *Store) Import(ctx context.Context, r io.Reader) (int, error) {
	var config struct {
		Credentials []struct {
			Name        string `json:"name"`
			URL         string `json:"url"`
			Type        string `json:"type"`
			Account     string `json:"account"`
			Password    string `json:"password"`
			PasswordEnv string `json:"password_env"`
			AccessToken string `json:"access_token"`
			TokenEnv    string `json:"access_token_env"`
			UserID      int64  `json:"user_id"`
		} `json:"credentials"`
	}
	data, err := io.ReadAll(io.LimitReader(r, (1<<20)+1))
	if err != nil || len(data) > 1<<20 {
		return 0, errors.New("cannot read configuration (limit: 1 MiB)")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&config) != nil || decoder.Decode(new(any)) != io.EOF || len(config.Credentials) == 0 {
		return 0, errors.New("expected one JSON object with a nonempty credentials array and known fields")
	}
	credentials := make([]Credential, 0, len(config.Credentials))
	seen := make(map[string]bool)
	for i, input := range config.Credentials {
		u, err := parseBaseURL(input.URL)
		if err != nil {
			return 0, fmt.Errorf("credential %d: %w", i+1, err)
		}
		c := Credential{Name: strings.TrimSpace(input.Name), URL: u.String(), Type: strings.ToLower(strings.TrimSpace(input.Type)), Account: strings.TrimSpace(input.Account), Password: input.Password, AccessToken: input.AccessToken, UserID: input.UserID}
		if c.Type == "new-api" {
			c.Type = "newapi"
		}
		if c.Type == "" || len(c.Type) > 64 || strings.ContainsFunc(c.Type, func(r rune) bool {
			return !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' || r == '_')
		}) {
			return 0, fmt.Errorf("credential %d: invalid provider type", i+1)
		}
		if input.PasswordEnv != "" {
			if c.Password != "" {
				return 0, fmt.Errorf("credential %d: choose password or password_env, not both", i+1)
			}
			c.Password = os.Getenv(input.PasswordEnv)
		}
		if input.TokenEnv != "" {
			if c.AccessToken != "" {
				return 0, fmt.Errorf("credential %d: choose access_token or access_token_env, not both", i+1)
			}
			c.AccessToken = os.Getenv(input.TokenEnv)
			if c.AccessToken == "" {
				return 0, fmt.Errorf("credential %d: access_token_env must be populated", i+1)
			}
		}
		if err := normalizeAuth(&c); err != nil {
			return 0, fmt.Errorf("credential %d: %w", i+1, err)
		}
		if c.Name == "" {
			c.Name = u.Host + " / " + c.Type
		}
		key := fmt.Sprintf("%s\x00%s\x00%s\x00%d", c.URL, c.Type, c.Account, c.UserID)
		if seen[key] {
			return 0, fmt.Errorf("credential %d: duplicate url/type/account/user_id", i+1)
		}
		seen[key] = true
		credentials = append(credentials, c)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	for _, c := range credentials {
		var id int64
		var password, token string
		err := tx.QueryRowContext(ctx, "SELECT id,password,access_token FROM credentials WHERE url=? AND type=? AND account=? AND user_id=?", c.URL, c.Type, c.Account, c.UserID).Scan(&id, &password, &token)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			_, err = tx.ExecContext(ctx, "INSERT INTO credentials(name,url,type,account,password,access_token,user_id) VALUES(?,?,?,?,?,?,?)", c.Name, c.URL, c.Type, c.Account, c.Password, c.AccessToken, c.UserID)
		case err == nil:
			changed := password != c.Password || token != c.AccessToken
			if changed {
				if _, err = tx.ExecContext(ctx, "DELETE FROM sessions WHERE credential_id=?", id); err != nil {
					return 0, err
				}
				if _, err = tx.ExecContext(ctx, "DELETE FROM snapshots WHERE credential_id=?", id); err != nil {
					return 0, err
				}
			}
			_, err = tx.ExecContext(ctx, "UPDATE credentials SET name=?,password=?,access_token=?,revision=revision+? WHERE id=?", c.Name, c.Password, c.AccessToken, changed, id)
		}
		if err != nil {
			return 0, err
		}
	}
	return len(credentials), tx.Commit()
}

func (s *Store) Credentials(ctx context.Context) ([]Credential, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT id,name,url,type,account,password,access_token,user_id,revision FROM credentials ORDER BY id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Credential{}
	for rows.Next() {
		var c Credential
		if err := rows.Scan(&c.ID, &c.Name, &c.URL, &c.Type, &c.Account, &c.Password, &c.AccessToken, &c.UserID, &c.Revision); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) Session(ctx context.Context, id int64) (Session, error) {
	var session Session
	var expires, cookies string
	err := s.db.QueryRowContext(ctx, "SELECT access_token,refresh_token,expires_at,user_id,session_id,cookies_json FROM sessions WHERE credential_id=?", id).
		Scan(&session.AccessToken, &session.RefreshToken, &expires, &session.UserID, &session.SessionID, &cookies)
	if errors.Is(err, sql.ErrNoRows) {
		return session, nil
	}
	if err != nil {
		return session, err
	}
	if session.ExpiresAt, err = time.Parse(time.RFC3339Nano, expires); err != nil {
		return Session{}, errors.New("invalid session expiry in SQLite")
	}
	if json.Unmarshal([]byte(cookies), &session.Cookies) != nil {
		return Session{}, errors.New("invalid session cookies in SQLite")
	}
	for _, c := range session.Cookies {
		if c == nil || c.Valid() != nil {
			return Session{}, errors.New("invalid session cookie in SQLite")
		}
	}
	return session, nil
}

func (s *Store) SaveSession(ctx context.Context, c Credential, session Session) error {
	cookies, err := json.Marshal(session.Cookies)
	if err != nil {
		return errors.New("cannot encode session cookies")
	}
	result, err := s.db.ExecContext(ctx, `INSERT INTO sessions(credential_id,access_token,refresh_token,expires_at,user_id,session_id,cookies_json,updated_at)
SELECT id,?,?,?,?,?,?,? FROM credentials WHERE id=? AND revision=?
ON CONFLICT(credential_id) DO UPDATE SET access_token=excluded.access_token,refresh_token=excluded.refresh_token,
expires_at=excluded.expires_at,user_id=excluded.user_id,session_id=excluded.session_id,cookies_json=excluded.cookies_json,updated_at=excluded.updated_at`,
		session.AccessToken, session.RefreshToken, session.ExpiresAt.UTC().Format(time.RFC3339Nano), session.UserID, session.SessionID, string(cookies), time.Now().UTC().Format(time.RFC3339Nano), c.ID, c.Revision)
	if err != nil {
		return err
	}
	if n, err := result.RowsAffected(); err != nil || n != 1 {
		return errors.Join(ErrCredentialChanged, err)
	}
	return nil
}

func (s *Store) SaveResult(ctx context.Context, c Credential, result Result) error {
	run, err := json.Marshal(result)
	if err != nil {
		return errors.New("cannot encode sync result")
	}
	var catalog, fetched any
	if result.Error == "" && result.Catalog != nil {
		data, err := json.Marshal(result.Catalog)
		if err != nil {
			return errors.New("cannot encode group snapshot")
		}
		catalog, fetched = string(data), result.CheckedAt.UTC().Format(time.RFC3339Nano)
	}
	res, err := s.db.ExecContext(ctx, `INSERT INTO snapshots(credential_id,fetched_at,catalog_json,last_run_json)
SELECT id,?,?,? FROM credentials WHERE id=? AND revision=?
ON CONFLICT(credential_id) DO UPDATE SET fetched_at=COALESCE(excluded.fetched_at,snapshots.fetched_at),
catalog_json=COALESCE(excluded.catalog_json,snapshots.catalog_json),last_run_json=excluded.last_run_json`, fetched, catalog, string(run), c.ID, c.Revision)
	if err != nil {
		return err
	}
	if n, err := res.RowsAffected(); err != nil || n != 1 {
		return errors.Join(ErrCredentialChanged, err)
	}
	return nil
}

func (s *Store) Sites(ctx context.Context) ([]StoredSite, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT c.id,c.name,c.url,c.type,c.account,c.user_id,s.fetched_at,s.catalog_json,s.last_run_json
FROM credentials c LEFT JOIN snapshots s ON s.credential_id=c.id ORDER BY c.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []StoredSite{}
	for rows.Next() {
		var site StoredSite
		var fetched, catalog, run sql.NullString
		c := &site.Credential
		if err := rows.Scan(&c.ID, &c.Name, &c.URL, &c.Type, &c.Account, &c.UserID, &fetched, &catalog, &run); err != nil {
			return nil, err
		}
		if fetched.Valid {
			t, err := time.Parse(time.RFC3339Nano, fetched.String)
			if err != nil {
				return nil, errors.New("invalid snapshot timestamp in SQLite")
			}
			site.FetchedAt = &t
		}
		if catalog.Valid && json.Unmarshal([]byte(catalog.String), &site.Snapshot) != nil {
			return nil, errors.New("invalid catalog snapshot in SQLite")
		}
		if run.Valid && json.Unmarshal([]byte(run.String), &site.LastRun) != nil {
			return nil, errors.New("invalid sync result in SQLite")
		}
		out = append(out, site)
	}
	return out, rows.Err()
}

func (s *Store) Remove(ctx context.Context, id int64) error {
	r, err := s.db.ExecContext(ctx, "DELETE FROM credentials WHERE id=?", id)
	if err != nil {
		return err
	}
	n, err := r.RowsAffected()
	if err == nil && n == 0 {
		return errors.New("credential not found")
	}
	return err
}

func (s *Store) acquire(ctx context.Context, id int64, owner string, until time.Time) (bool, error) {
	r, err := s.db.ExecContext(ctx, `INSERT INTO leases(credential_id,owner,expires_at) VALUES(?,?,?)
ON CONFLICT(credential_id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE leases.expires_at<=?`, id, owner, until.Unix(), time.Now().Unix())
	if err != nil {
		return false, err
	}
	n, err := r.RowsAffected()
	return n == 1, err
}

func (s *Store) release(ctx context.Context, id int64, owner string) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM leases WHERE credential_id=? AND owner=?", id, owner)
	return err
}
