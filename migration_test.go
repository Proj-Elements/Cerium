package cerium

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLegacyCredentialMigrationPreservesData(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "legacy.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	legacy := strings.Replace(schema, "  access_token TEXT NOT NULL DEFAULT '',\n  user_id INTEGER NOT NULL DEFAULT 0,\n", "", 1)
	legacy = strings.Replace(legacy, "UNIQUE(url, type, account, user_id)", "UNIQUE(url, type, account)", 1)
	if _, err = db.Exec(legacy + `
INSERT INTO credentials(id,name,url,type,account,password) VALUES(7,'Legacy','https://old.invalid','newapi','u','p');
INSERT INTO credentials(id,name,url,type,account,password) VALUES(99,'Deleted','https://deleted.invalid','newapi','u','p');
DELETE FROM credentials WHERE id=99;`); err != nil {
		t.Fatal(err)
	}
	old := &Store{db: db}
	c := Credential{ID: 7, Revision: 1}
	if err := old.SaveSession(ctx, c, Session{AccessToken: "saved-token", UserID: 7}); err != nil {
		t.Fatal(err)
	}
	if err := old.SaveResult(ctx, c, Result{CheckedAt: time.Now(), Catalog: &Catalog{Groups: []Group{}}}); err != nil {
		t.Fatal(err)
	}
	if ok, err := old.acquire(ctx, c.ID, "owner", time.Now().Add(time.Minute)); !ok || err != nil {
		t.Fatal("could not seed lease")
	}
	if _, err := NewBridge(old, "0123456789abcdef0123456789abcdef", &bridgeSink{}); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("INSERT INTO bridge_sites VALUES('existing-site',7,3)"); err != nil {
		t.Fatal(err)
	}
	old.Close()
	for range 2 {
		store, err := OpenStore(path)
		if err != nil {
			t.Fatal(err)
		}
		credentials, err := store.Credentials(ctx)
		if err != nil || len(credentials) != 1 || credentials[0].Password != "p" || credentials[0].ID != 7 || credentials[0].UserID != 0 {
			t.Fatal("migration changed legacy credentials")
		}
		session, err := store.Session(ctx, 7)
		if err != nil || session.AccessToken != "saved-token" {
			t.Fatal("migration lost a session")
		}
		sites, err := store.Sites(ctx)
		if err != nil || sites[0].Snapshot == nil {
			t.Fatal("migration lost a snapshot")
		}
		var id, seq, foreignKeys int64
		if err = store.db.QueryRow("SELECT credential_id FROM bridge_sites").Scan(&id); err != nil || id != 7 {
			t.Fatal("migration broke bridge references")
		}
		store.db.QueryRow("SELECT seq FROM sqlite_sequence WHERE name='credentials'").Scan(&seq)
		store.db.QueryRow("PRAGMA foreign_keys").Scan(&foreignKeys)
		if seq != 99 || foreignKeys != 1 {
			t.Fatal("migration lost the ID high-water mark or disabled foreign keys")
		}
		store.Close()
	}
	store, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	all := importCredentials(t, store, Credential{URL: "https://old.invalid", Type: "newapi", AccessToken: "new-token", UserID: 8})
	if len(all) != 2 || all[1].ID <= 99 {
		t.Fatal("migration reused a deleted ID")
	}
	if err := store.Remove(ctx, 7); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"sessions", "snapshots", "leases"} {
		var count int
		if err := store.db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil || count != 0 {
			t.Fatalf("migration broke cascade deletion in %s", table)
		}
	}
}
