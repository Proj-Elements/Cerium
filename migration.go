package cerium

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

func migrateCredentials(ctx context.Context, db *sql.DB) (err error) {
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	// Rebuild the legacy UNIQUE constraint without cascading into saved sessions.
	if _, err = conn.ExecContext(ctx, "PRAGMA foreign_keys=OFF"); err != nil {
		return err
	}
	defer func() {
		_, restoreErr := conn.ExecContext(context.Background(), "PRAGMA foreign_keys=ON")
		err = errors.Join(err, restoreErr)
	}()
	if _, err = conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return err
	}
	defer conn.ExecContext(context.Background(), "ROLLBACK")
	var present int
	if err = conn.QueryRowContext(ctx, "SELECT COUNT(*) FROM pragma_table_info('credentials') WHERE name='access_token'").Scan(&present); err != nil {
		return err
	}
	if present == 0 {
		create := strings.Replace(credentialSchema, "credentials (", "credentials_next (", 1)
		_, err = conn.ExecContext(ctx, create+`
INSERT INTO credentials_next(id,name,url,type,account,password,revision)
 SELECT id,name,url,type,account,password,revision FROM credentials;
UPDATE sqlite_sequence SET seq=MAX(seq,COALESCE((SELECT seq FROM sqlite_sequence WHERE name='credentials'),0)) WHERE name='credentials_next';
DROP TABLE credentials;
ALTER TABLE credentials_next RENAME TO credentials;`)
		if err != nil {
			return err
		}
		var violations int
		if err = conn.QueryRowContext(ctx, "SELECT COUNT(*) FROM pragma_foreign_key_check").Scan(&violations); err != nil {
			return err
		}
		if violations != 0 {
			return errors.New("credential migration would break foreign keys")
		}
	}
	_, err = conn.ExecContext(ctx, "COMMIT")
	return err
}
