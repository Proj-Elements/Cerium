package cerium

import (
	"bytes"
	"compress/gzip"
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

const maxRecoveryBytes = 256 << 20

var errRecoverySize = errors.New("recovery payload exceeds limit")
var errRecoveryBusy = errors.New("synchronization lease is active")

var recoveryTables = []string{
	"credentials", "sessions", "snapshots", "model_probes", "bridge_sites", "bridge_jobs",
	"model_probe_cleanup", "model_probe_refreshes", "sqlite_sequence",
}

type recoveryArchive struct {
	Format    string                   `json:"format"`
	Version   int                      `json:"version"`
	CreatedAt time.Time                `json:"created_at"`
	Tables    map[string]recoveryTable `json:"tables"`
}

type recoveryTable struct {
	Columns []string `json:"columns"`
	Rows    [][]any  `json:"rows"`
}

type recoveryColumn struct {
	name     string
	kind     string
	required bool
	primary  bool
}

func (b *Bridge) recovery(w http.ResponseWriter, r *http.Request, body []byte, gate *sync.RWMutex) {
	if !gate.TryLock() {
		b.recoveryResponse(w, http.StatusServiceUnavailable, map[string]any{"error": "worker_busy", "code": "worker_busy", "stage": "recovery"})
		return
	}
	defer gate.Unlock()
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	if r.URL.Path == "/v1/recovery/export" {
		var input struct{}
		if decodeRecovery(body, &input) != nil {
			b.recoveryResponse(w, http.StatusBadRequest, map[string]any{"error": "invalid_recovery_request", "code": "invalid_recovery_request", "stage": "recovery"})
			return
		}
		archive, err := b.store.exportRecovery(ctx)
		if err != nil {
			if errors.Is(err, errRecoveryBusy) {
				b.recoveryResponse(w, http.StatusServiceUnavailable, map[string]any{"error": "worker_busy", "code": "worker_busy", "stage": "recovery"})
				return
			}
			if errors.Is(err, errRecoverySize) {
				b.recoveryResponse(w, http.StatusRequestEntityTooLarge, map[string]any{"error": "recovery_size_limit", "code": "recovery_size_limit", "stage": "recovery"})
				return
			}
			b.recoveryResponse(w, http.StatusInternalServerError, map[string]any{"error": "recovery_export_failed", "code": "recovery_export_failed", "stage": "recovery"})
			return
		}
		b.recoveryResponse(w, http.StatusOK, archive, strings.Contains(r.Header.Get("Accept-Encoding"), "gzip"))
		return
	}
	var archive recoveryArchive
	if decodeRecovery(body, &archive) != nil || archive.Format != "cerium-worker-recovery" || archive.Version != 1 || archive.CreatedAt.IsZero() || archive.CreatedAt.After(time.Now().Add(5*time.Minute)) {
		b.recoveryResponse(w, http.StatusBadRequest, map[string]any{"error": "invalid_recovery_archive", "code": "invalid_recovery_archive", "stage": "recovery"})
		return
	}
	validateOnly := r.URL.Path == "/v1/recovery/validate"
	if err := b.store.importRecovery(ctx, archive, validateOnly); err != nil {
		if errors.Is(err, errRecoveryBusy) {
			b.recoveryResponse(w, http.StatusServiceUnavailable, map[string]any{"error": "worker_busy", "code": "worker_busy", "stage": "recovery"})
			return
		}
		b.recoveryResponse(w, http.StatusBadRequest, map[string]any{"error": "invalid_recovery_state", "code": "invalid_recovery_state", "stage": "recovery"})
		return
	}
	b.recoveryResponse(w, http.StatusOK, map[string]any{"restored": !validateOnly, "validated": true})
}

func decodeRecovery(body []byte, target any) error {
	if len(body) > maxRecoveryBytes {
		return errRecoverySize
	}
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return errors.New("expected a recovery object")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	decoder.UseNumber()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return errors.New("expected one recovery document")
	}
	return nil
}

func (b *Bridge) recoveryResponse(w http.ResponseWriter, status int, value any, compressed ...bool) {
	body, err := json.Marshal(value)
	if err != nil || len(body) >= maxRecoveryBytes {
		status, body = http.StatusRequestEntityTooLarge, []byte(`{"error":"recovery_size_limit","code":"recovery_size_limit","stage":"recovery"}`)
	}
	body = append(body, '\n')
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, b.secret)
	mac.Write([]byte(timestamp + "\n"))
	mac.Write(body)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Cerium-Timestamp", timestamp)
	w.Header().Set("X-Cerium-Signature", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	if len(compressed) > 0 && compressed[0] {
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Set("Vary", "Accept-Encoding")
		w.WriteHeader(status)
		writer := gzip.NewWriter(w)
		writer.Write(body)
		writer.Close()
		return
	}
	w.WriteHeader(status)
	w.Write(body)
}

func recoveryColumns(ctx context.Context, tx *sql.Tx, table string) ([]recoveryColumn, error) {
	rows, err := tx.QueryContext(ctx, "PRAGMA table_info("+table+")")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	columns := []recoveryColumn{}
	for rows.Next() {
		var position, required, primary int
		var column recoveryColumn
		var defaultValue any
		if err := rows.Scan(&position, &column.name, &column.kind, &required, &defaultValue, &primary); err != nil {
			return nil, err
		}
		column.required, column.primary = required != 0, primary != 0
		if table == "sqlite_sequence" && column.kind == "" {
			column.required = true
			if column.name == "name" {
				column.kind = "TEXT"
			} else if column.name == "seq" {
				column.kind = "INTEGER"
			}
		}
		if column.kind != "TEXT" && column.kind != "INTEGER" {
			return nil, errors.New("unsupported recovery column type")
		}
		columns = append(columns, column)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(columns) == 0 {
		return nil, errors.New("missing recovery table")
	}
	return columns, nil
}

func (s *Store) exportRecovery(ctx context.Context) (recoveryArchive, error) {
	archive := recoveryArchive{Format: "cerium-worker-recovery", Version: 1, CreatedAt: time.Now().UTC(), Tables: map[string]recoveryTable{}}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return archive, err
	}
	defer tx.Rollback()
	if err := recoveryLeaseGuard(ctx, tx); err != nil {
		return archive, err
	}
	bytesRead := 0
	for _, name := range recoveryTables {
		columns, err := recoveryColumns(ctx, tx, name)
		if err != nil {
			return archive, err
		}
		table := recoveryTable{Columns: make([]string, len(columns)), Rows: [][]any{}}
		for index, column := range columns {
			table.Columns[index] = column.name
		}
		query := "SELECT * FROM " + name
		if name == "sqlite_sequence" {
			query += " WHERE name='credentials'"
		}
		rows, err := tx.QueryContext(ctx, query)
		if err != nil {
			return archive, err
		}
		for rows.Next() {
			values := make([]any, len(columns))
			pointers := make([]any, len(columns))
			for index := range values {
				pointers[index] = &values[index]
			}
			if err := rows.Scan(pointers...); err != nil {
				rows.Close()
				return archive, err
			}
			for _, value := range values {
				if text, ok := value.(string); ok {
					bytesRead += len(text)
				} else {
					bytesRead += 20
				}
			}
			if bytesRead > maxRecoveryBytes {
				rows.Close()
				return archive, errRecoverySize
			}
			table.Rows = append(table.Rows, values)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return archive, err
		}
		archive.Tables[name] = table
	}
	return archive, tx.Commit()
}

func (s *Store) importRecovery(ctx context.Context, archive recoveryArchive, validateOnly bool) error {
	if len(archive.Tables) != len(recoveryTables) {
		return errors.New("unexpected recovery tables")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := recoveryLeaseGuard(ctx, tx); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "PRAGMA defer_foreign_keys=ON"); err != nil {
		return err
	}
	totalRows := 0
	for _, name := range recoveryTables {
		table, exists := archive.Tables[name]
		if !exists || table.Rows == nil {
			return errors.New("missing recovery table")
		}
		columns, err := recoveryColumns(ctx, tx, name)
		if err != nil || len(columns) != len(table.Columns) {
			return errors.New("incompatible recovery schema")
		}
		for index, column := range columns {
			if table.Columns[index] != column.name {
				return errors.New("incompatible recovery columns")
			}
		}
		totalRows += len(table.Rows)
		if totalRows > 1_000_000 {
			return errors.New("too many recovery rows")
		}
		for _, row := range table.Rows {
			if err := validateRecoveryRow(name, columns, row); err != nil {
				return err
			}
		}
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM leases"); err != nil {
		return err
	}
	for index := len(recoveryTables) - 1; index >= 0; index-- {
		name := recoveryTables[index]
		query := "DELETE FROM " + name
		if name == "sqlite_sequence" {
			query += " WHERE name='credentials'"
		}
		if _, err = tx.ExecContext(ctx, query); err != nil {
			return err
		}
	}
	for _, name := range recoveryTables {
		table := archive.Tables[name]
		if name == "sqlite_sequence" {
			if _, err := tx.ExecContext(ctx, "DELETE FROM sqlite_sequence WHERE name='credentials'"); err != nil {
				return err
			}
		}
		placeholders := strings.TrimRight(strings.Repeat("?,", len(table.Columns)), ",")
		statement, err := tx.PrepareContext(ctx, "INSERT INTO "+name+" VALUES("+placeholders+")")
		if err != nil {
			return err
		}
		for _, row := range table.Rows {
			values := make([]any, len(row))
			for index, value := range row {
				if integer, ok := value.(json.Number); ok {
					values[index], _ = integer.Int64()
				} else {
					values[index] = value
				}
			}
			if _, err := statement.ExecContext(ctx, values...); err != nil {
				statement.Close()
				return err
			}
		}
		if err := statement.Close(); err != nil {
			return err
		}
	}
	var violations int
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM pragma_foreign_key_check").Scan(&violations); err != nil || violations != 0 {
		return errors.New("recovery foreign key violation")
	}
	var sequenceCount int
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM sqlite_sequence WHERE name='credentials'").Scan(&sequenceCount); err != nil || sequenceCount > 1 {
		return errors.New("invalid recovery sequence")
	}
	var sequence, greatestID int64
	if err := tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(seq),0) FROM sqlite_sequence WHERE name='credentials'").Scan(&sequence); err != nil {
		return err
	}
	if err := tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(id),0) FROM credentials").Scan(&greatestID); err != nil || sequence < greatestID {
		return errors.New("invalid recovery credential sequence")
	}
	if validateOnly {
		return tx.Rollback()
	}
	return tx.Commit()
}

func recoveryLeaseGuard(ctx context.Context, tx *sql.Tx) error {
	var active int
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM leases WHERE expires_at>?", time.Now().Unix()).Scan(&active); err != nil {
		return err
	}
	if active != 0 {
		return errRecoveryBusy
	}
	return nil
}

func validateRecoveryRow(table string, columns []recoveryColumn, row []any) error {
	if len(row) != len(columns) {
		return errors.New("invalid recovery row width")
	}
	values := make(map[string]any, len(columns))
	for index, column := range columns {
		value := row[index]
		if value == nil {
			if column.required || column.primary {
				return errors.New("missing recovery field")
			}
			continue
		}
		switch column.kind {
		case "TEXT":
			text, valid := value.(string)
			if !valid || len(text) > 8<<20 || (column.primary && text == "") {
				return errors.New("invalid recovery text field")
			}
			values[column.name] = text
		case "INTEGER":
			integer, valid := value.(json.Number)
			if !valid {
				return errors.New("invalid recovery integer field")
			}
			number, err := integer.Int64()
			if err != nil {
				return errors.New("invalid recovery integer value")
			}
			values[column.name] = number
		}
	}
	for _, field := range []string{"credential_id", "revision"} {
		if value, exists := values[field]; exists && value.(int64) <= 0 {
			return errors.New("invalid recovery identity")
		}
	}
	if table == "credentials" {
		credential := Credential{ID: values["id"].(int64), Name: values["name"].(string), URL: values["url"].(string), Type: values["type"].(string), Account: values["account"].(string), Password: values["password"].(string), AccessToken: values["access_token"].(string), UserID: values["user_id"].(int64)}
		if _, err := parseBaseURL(credential.URL); err != nil || credential.ID <= 0 || normalizeAuth(&credential) != nil {
			return errors.New("invalid recovered credential")
		}
	}
	if table == "bridge_jobs" {
		identity, digest, state := values["id"].(string), values["digest"].(string), values["state"].(string)
		if len(identity) < 16 || len(identity) > 128 || len(digest) != sha256.Size*2 {
			return errors.New("invalid recovered job")
		}
		if _, err := hex.DecodeString(digest); err != nil {
			return errors.New("invalid recovered job digest")
		}
		if state != "pending" && state != "delivered" && state != "rejected" && state != "expired" {
			return errors.New("invalid recovered job state")
		}
		if state == "pending" {
			var result Result
			if json.Unmarshal([]byte(values["result"].(string)), &result) != nil || result.JobID != identity || len(result.SiteID) < 16 || result.ConfigRevision < 1 {
				return errors.New("invalid recovered pending job")
			}
		}
	}
	if table == "model_probes" || table == "model_probe_cleanup" {
		state := values["state"].(string)
		if values["key_id"].(int64) < 0 || (state != "creating" && state != "ready" && state != "fetching" && state != "cleanup" && state != "done") {
			return errors.New("invalid recovered probe state")
		}
	}
	if table == "bridge_sites" {
		identity := values["site_id"].(string)
		if len(identity) < 16 || len(identity) > 128 {
			return errors.New("invalid recovered bridge site")
		}
	}
	if table == "model_probe_refreshes" {
		identity := values["job_id"].(string)
		if len(identity) < 16 || len(identity) > 128 {
			return errors.New("invalid recovered refresh marker")
		}
	}
	if value, exists := values["cookies_json"]; exists {
		var cookies []*http.Cookie
		if json.Unmarshal([]byte(value.(string)), &cookies) != nil {
			return errors.New("invalid recovered cookies")
		}
		for _, cookie := range cookies {
			if cookie == nil || cookie.Valid() != nil {
				return errors.New("invalid recovered cookie")
			}
		}
	}
	if value, exists := values["models_json"]; exists {
		var models []string
		if json.Unmarshal([]byte(value.(string)), &models) != nil || models == nil || len(models) > 10000 {
			return errors.New("invalid recovered models")
		}
		for _, model := range models {
			if model == "" || len(model) > 300 {
				return errors.New("invalid recovered model")
			}
		}
	}
	if value, exists := values["catalog_json"]; exists {
		var catalog Catalog
		if json.Unmarshal([]byte(value.(string)), &catalog) != nil || normalizeCatalog(&catalog) != nil {
			return errors.New("invalid recovered catalog")
		}
	}
	if value, exists := values["last_run_json"]; exists {
		var result Result
		if json.Unmarshal([]byte(value.(string)), &result) != nil {
			return errors.New("invalid recovered result")
		}
	}
	for _, field := range []string{"expires_at", "updated_at", "fetched_at"} {
		if value, exists := values[field]; exists && value.(string) != "" {
			if _, err := time.Parse(time.RFC3339Nano, value.(string)); err != nil {
				return errors.New("invalid recovered timestamp")
			}
		}
	}
	if table == "sqlite_sequence" && (values["name"] != "credentials" || values["seq"].(int64) < 0) {
		return errors.New("invalid recovery sequence row")
	}
	return nil
}
