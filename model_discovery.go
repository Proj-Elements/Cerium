package cerium

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"
)

type modelProbe struct {
	Source, GroupID, State, Name, Secret string
	KeyID                                int64
	Models                               sql.NullString
	FetchedAt, Error                     string
}

type probeKey struct {
	ID      int64  `json:"id"`
	GroupID int64  `json:"group_id"`
	Name    string `json:"name"`
	Key     string `json:"key"`
}

func (p *sub2API) canStartModelProbe(ctx context.Context) bool {
	deadline, limited := ctx.Deadline()
	return ctx.Err() == nil && (!limited || time.Until(deadline) >= 2*p.client.client.Timeout+10*time.Second)
}

// A zero balance only proves a public standard group is blocked when the
// upstream confirms standard mode. Simple mode skips the balance check, and
// forks that omit run_mode still get their one gateway attempt.
func (p *sub2API) modelBalanceBlocked(ctx context.Context, session *Session) bool {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	response, err := p.client.request(ctx, session, http.MethodGet, "/api/v1/auth/me", nil)
	if err != nil {
		return false
	}
	profile, err := decodeData[struct {
		RunMode string   `json:"run_mode"`
		Balance *float64 `json:"balance"`
	}](response)
	return err == nil && profile.RunMode == "standard" && profile.Balance != nil && *profile.Balance <= 0
}

func (p *sub2API) saveProbe(ctx context.Context, probe *modelProbe) error {
	ctx, cancel := persistenceContext(ctx)
	defer cancel()
	r, err := p.store.db.ExecContext(ctx, `INSERT INTO model_probes
(credential_id,source,group_id,state,key_name,key_secret,key_id,models_json,fetched_at,error)
SELECT id,?,?,?,?,?,?,?,?,? FROM credentials WHERE id=? AND revision=?
ON CONFLICT(credential_id,source,group_id) DO UPDATE SET state=excluded.state,key_secret=excluded.key_secret,
key_id=excluded.key_id,models_json=excluded.models_json,fetched_at=excluded.fetched_at,error=excluded.error`,
		probe.Source, probe.GroupID, probe.State, probe.Name, probe.Secret, probe.KeyID, probe.Models, probe.FetchedAt, probe.Error, p.credential.ID, p.credential.Revision)
	if err != nil {
		return err
	}
	if n, err := r.RowsAffected(); err != nil || n != 1 {
		return errors.Join(ErrCredentialChanged, err)
	}
	return nil
}

func (p *sub2API) discoverModels(ctx context.Context, session *Session, catalog *Catalog) error {
	if p.store == nil {
		catalog.Warnings = append(catalog.Warnings, "one-time gateway model discovery requires a SQLite-backed sync run")
		return nil
	}
	source := fmt.Sprintf("%x", sha256.Sum256([]byte(p.credential.URL+"\x00"+p.credential.Account)))
	rows, err := p.store.db.QueryContext(ctx, `SELECT group_id,state,key_name,key_secret,key_id,models_json,fetched_at,error FROM model_probes WHERE credential_id=? AND source=?`, p.credential.ID, source)
	if err != nil {
		return err
	}
	probes := map[string]*modelProbe{}
	for rows.Next() {
		probe := &modelProbe{Source: source}
		if err := rows.Scan(&probe.GroupID, &probe.State, &probe.Name, &probe.Secret, &probe.KeyID, &probe.Models, &probe.FetchedAt, &probe.Error); err != nil {
			rows.Close()
			return err
		}
		probes[probe.GroupID] = probe
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	// Resume cleanup even when a group disappeared or became private. A saved
	// 'creating' marker is reconciled, never blindly replayed as another POST.
	for _, probe := range probes {
		if ctx.Err() != nil {
			break
		}
		if probe.State != "done" {
			if err := p.resumeProbe(ctx, session, probe); err != nil {
				return err
			}
		}
	}
	limit := 4
	if n, err := strconv.Atoi(os.Getenv("CERIUM_MODEL_PROBES_PER_RUN")); err == nil && n >= 1 && n <= 20 {
		limit = n
	}
	pending, failed, cleanup, balanceDeferred := 0, 0, 0, 0
	balanceChecked, balanceBlocked := false, false
	failureReasons := map[string]int{}
	for i := range catalog.Groups {
		g := &catalog.Groups[i]
		probe := probes[g.ID]
		var retained int
		if probe == nil {
			if err := p.store.db.QueryRowContext(ctx, `SELECT count(*) FROM model_probe_cleanup
WHERE credential_id=? AND source=? AND group_id=?`, p.credential.ID, source, g.ID).Scan(&retained); err != nil {
				return err
			}
		}
		if retained > 0 {
			pending++
			continue
		}
		if probe == nil && limit > 0 && p.publicOnly && !balanceChecked && p.canStartModelProbe(ctx) {
			balanceChecked = true
			balanceBlocked = p.modelBalanceBlocked(ctx, session)
		}
		if probe == nil && balanceBlocked {
			balanceDeferred++
			continue
		}
		if probe == nil && limit > 0 && p.canStartModelProbe(ctx) {
			limit--
			probe = &modelProbe{Source: source, GroupID: g.ID, State: "creating", Name: "cerium-models-" + rand.Text(), Secret: "sk-" + rand.Text()}
			if err := p.saveProbe(ctx, probe); err != nil {
				return err
			}
			id, err := strconv.ParseInt(g.ID, 10, 64)
			if err != nil || id <= 0 {
				return errors.New("invalid Sub2API group ID")
			}
			e, createErr := p.client.requestWith(ctx, session, http.MethodPost, "/api/v1/keys", map[string]any{
				"name": probe.Name, "group_id": id, "custom_key": probe.Secret,
				"expires_in_days": 1, "quota": 0.000001,
			}, requestOptions{headers: http.Header{"Idempotency-Key": {probe.Name}}})
			if createErr == nil {
				key, decodeErr := decodeData[probeKey](e)
				if decodeErr == nil && validProbeKey(probe, key) {
					probe.KeyID, probe.Secret, probe.State = key.ID, key.Key, "ready"
				} else {
					createErr = errors.New("invalid probe key response")
				}
			}
			if createErr != nil {
				probe.Error = "key creation did not complete; no automatic recreation"
				// Reconcile even on an HTTP error: an intermediary can lose a
				// successful response. Never assume that no remote key exists.
			}
			if err := p.saveProbe(ctx, probe); err != nil {
				return err
			}
			if err := p.resumeProbe(ctx, session, probe); err != nil {
				return err
			}
			probes[g.ID] = probe
		}
		if probe == nil {
			pending++
			continue
		}
		if probe.Models.Valid {
			if json.Unmarshal([]byte(probe.Models.String), &g.Models) != nil {
				return errors.New("invalid saved gateway model list")
			}
			g.ModelsKnown, g.ModelsSource, g.ModelsFetchedAt = true, "gateway_once", probe.FetchedAt
		} else {
			failed++
			failureReasons[savedModelFailureReason(probe.Error)]++
		}
	}
	for _, probe := range probes {
		if probe.State != "done" {
			cleanup++
		}
	}
	if pending > 0 {
		catalog.Warnings = append(catalog.Warnings, fmt.Sprintf("one-time gateway model discovery pending for %d groups; continuing in later sync rounds", pending))
	}
	if balanceDeferred > 0 {
		catalog.Warnings = append(catalog.Warnings, fmt.Sprintf("one-time gateway model discovery deferred for %d groups: account balance is not positive; no key or model request was attempted", balanceDeferred))
	}
	if failed > 0 {
		reasons := make([]string, 0, len(failureReasons))
		for reason, count := range failureReasons {
			reasons = append(reasons, fmt.Sprintf("%s=%d", reason, count))
		}
		slices.Sort(reasons)
		catalog.Warnings = append(catalog.Warnings, fmt.Sprintf("one-time gateway model discovery unavailable for %d groups (%s); resolve the upstream condition and explicitly refresh models; saved attempts are not retried", failed, strings.Join(reasons, ", ")))
	}
	if cleanup > 0 {
		catalog.Warnings = append(catalog.Warnings, fmt.Sprintf("%d temporary model keys still need reconciliation or deletion; cleanup will retry", cleanup))
	}
	return nil
}

func validProbeKey(probe *modelProbe, key probeKey) bool {
	return key.ID > 0 && strconv.FormatInt(key.GroupID, 10) == probe.GroupID && key.Name == probe.Name && key.Key != ""
}

func (p *sub2API) resumeProbe(ctx context.Context, session *Session, probe *modelProbe) error {
	if probe.State == "creating" {
		e, err := p.client.requestWith(ctx, session, http.MethodGet, "/api/v1/keys", nil, requestOptions{query: url.Values{"search": {probe.Name}, "page_size": {"100"}}})
		if err != nil {
			return nil
		}
		data, err := decodeData[struct {
			Items []probeKey `json:"items"`
			Total int        `json:"total"`
		}](e)
		if err != nil || data.Items == nil {
			return nil
		}
		for _, key := range data.Items {
			if validProbeKey(probe, key) {
				probe.KeyID, probe.Secret, probe.State = key.ID, key.Key, "ready"
				break
			}
		}
		if probe.State == "creating" {
			if data.Total > len(data.Items) {
				return nil
			}
			probe.State, probe.Secret, probe.Error = "done", "", "no matching key after interrupted creation; not recreating"
		}
		if err := p.saveProbe(ctx, probe); err != nil {
			return err
		}
	}
	if probe.State == "fetching" {
		probe.State, probe.Error = "cleanup", "model response interrupted; not repeating the one-time request"
		if err := p.saveProbe(ctx, probe); err != nil {
			return err
		}
	}
	if probe.State == "ready" {
		probe.State = "fetching"
		if err := p.saveProbe(ctx, probe); err != nil {
			return err
		}
		// Only the temporary gateway key goes to /v1/models, never panel AT/RT.
		data, status, err := p.client.rawRequest(ctx, &Session{AccessToken: probe.Secret}, http.MethodGet, "/v1/models", nil, requestOptions{noRetry: true})
		var list struct {
			Data []struct {
				ID string `json:"id"`
			} `json:"data"`
		}
		if err != nil || status != http.StatusOK || json.Unmarshal(data, &list) != nil || list.Data == nil || len(list.Data) > 10000 {
			probe.Error = fmt.Sprintf("gateway model discovery failed (HTTP %d; %s); not repeating", status, modelFailureReason(data, status, err))
		} else {
			models := make([]string, 0, len(list.Data))
			for _, m := range list.Data {
				if m.ID == "" || len(m.ID) > 300 {
					probe.Error = "invalid gateway model ID"
					break
				}
				models = append(models, m.ID)
			}
			if len(models) == len(list.Data) {
				slices.Sort(models)
				encoded, _ := json.Marshal(slices.Compact(models))
				probe.Models = sql.NullString{String: string(encoded), Valid: true}
				probe.FetchedAt, probe.Error = time.Now().UTC().Format(time.RFC3339Nano), ""
			}
		}
		probe.State = "cleanup"
		if err := p.saveProbe(ctx, probe); err != nil {
			return err
		}
	}
	if probe.State == "cleanup" {
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		_, err := p.client.request(cleanupCtx, session, http.MethodDelete, "/api/v1/keys/"+strconv.FormatInt(probe.KeyID, 10), nil)
		if err == nil || hasStatus(err, http.StatusNotFound) {
			probe.State, probe.Secret = "done", ""
			return p.saveProbe(ctx, probe)
		}
	}
	return nil
}

var upstreamModelFailureCodes = []string{
	"INSUFFICIENT_BALANCE", "API_KEY_QUOTA_EXHAUSTED", "API_KEY_EXPIRED",
	"SUBSCRIPTION_NOT_FOUND", "SUBSCRIPTION_INVALID", "USAGE_LIMIT_EXCEEDED",
	"ACCESS_DENIED", "GROUP_NOT_ALLOWED", "GROUP_DISABLED", "GROUP_NOT_FOUND",
	"INVALID_API_KEY", "USER_INACTIVE", "insufficient_quota",
}

func modelFailureReason(data []byte, status int, err error) string {
	if err != nil {
		var network net.Error
		switch {
		case errors.Is(err, context.DeadlineExceeded), errors.As(err, &network) && network.Timeout():
			return "timeout"
		case errors.Is(err, context.Canceled):
			return "canceled"
		default:
			return "transport_or_response_failure"
		}
	}
	var failure struct {
		Code  string `json:"code"`
		Error struct {
			Code string `json:"code"`
			Type string `json:"type"`
		} `json:"error"`
	}
	if json.Unmarshal(data, &failure) == nil {
		for _, code := range []string{failure.Code, failure.Error.Code, failure.Error.Type} {
			if slices.Contains(upstreamModelFailureCodes, code) {
				return code
			}
		}
	}
	switch status {
	case http.StatusForbidden:
		return "access_denied"
	case http.StatusUnauthorized:
		return "authentication"
	case http.StatusTooManyRequests:
		return "rate_limited"
	case http.StatusOK:
		return "invalid_response"
	default:
		return "upstream_http"
	}
}

func savedModelFailureReason(message string) string {
	switch message {
	case "no matching key after interrupted creation; not recreating":
		return "key_creation_failed"
	case "key creation did not complete; no automatic recreation":
		return "key_creation_unconfirmed"
	case "model response interrupted; not repeating the one-time request":
		return "interrupted"
	case "invalid gateway model ID":
		return "invalid_response"
	case "gateway model discovery failed (HTTP 403); not repeating":
		return "access_denied_check_balance_or_permissions"
	case "gateway model discovery failed (HTTP 0); not repeating":
		return "transport_failure"
	}
	_, reason, _ := strings.Cut(message, "; ")
	reason, valid := strings.CutSuffix(reason, "); not repeating")
	if valid && (slices.Contains(upstreamModelFailureCodes, reason) || slices.Contains([]string{
		"timeout", "canceled", "transport_or_response_failure", "access_denied",
		"authentication", "rate_limited", "invalid_response", "upstream_http",
	}, reason)) {
		return reason
	}
	return "discovery_unavailable"
}
