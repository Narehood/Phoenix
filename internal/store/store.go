package store

import (
	"database/sql"
	"errors"
	_ "modernc.org/sqlite"
	"os"
	"path/filepath"
	"time"
)

func Open(path string) (*sql.DB, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA max_page_count=65536;
 CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,role TEXT NOT NULL,password BLOB NOT NULL,totp TEXT NOT NULL,totp_step INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS grants(user_id TEXT NOT NULL REFERENCES users(id),scope_type TEXT NOT NULL,scope TEXT NOT NULL,action TEXT NOT NULL,PRIMARY KEY(user_id,scope_type,scope,action));
 CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,data BLOB NOT NULL,expiry INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS setup(id INTEGER PRIMARY KEY CHECK(id=1),token_hash TEXT NOT NULL,expires INTEGER NOT NULL,name TEXT NOT NULL DEFAULT '',password BLOB,totp TEXT NOT NULL DEFAULT '');
 CREATE TABLE IF NOT EXISTS hosts(id TEXT PRIMARY KEY,name TEXT NOT NULL,os TEXT NOT NULL DEFAULT '',os_version TEXT NOT NULL DEFAULT '',addresses TEXT NOT NULL DEFAULT '[]',tags TEXT NOT NULL DEFAULT '[]',groups_json TEXT NOT NULL DEFAULT '[]',agent_version TEXT NOT NULL DEFAULT '',last_contact INTEGER NOT NULL DEFAULT 0,revoked INTEGER NOT NULL DEFAULT 1,verified INTEGER NOT NULL DEFAULT 0,fingerprint TEXT NOT NULL DEFAULT '',serial TEXT NOT NULL DEFAULT '',generation INTEGER NOT NULL DEFAULT 0,boot_id TEXT NOT NULL DEFAULT '');
 CREATE TABLE IF NOT EXISTS invitations(hash TEXT PRIMARY KEY,host_id TEXT NOT NULL REFERENCES hosts(id),expires INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS samples(id INTEGER PRIMARY KEY AUTOINCREMENT,host_id TEXT NOT NULL REFERENCES hosts(id),measured INTEGER NOT NULL,collected INTEGER NOT NULL,payload TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS samples_host ON samples(host_id,id);
 CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,actor TEXT NOT NULL REFERENCES users(id),host_id TEXT NOT NULL REFERENCES hosts(id),action TEXT NOT NULL,args TEXT NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,deadline INTEGER NOT NULL,timeout INTEGER NOT NULL DEFAULT 30,dispatched INTEGER NOT NULL DEFAULT 0,finished INTEGER NOT NULL DEFAULT 0,cancel INTEGER NOT NULL DEFAULT 0,boot_before TEXT NOT NULL DEFAULT '',reboot_observed INTEGER NOT NULL DEFAULT 0,result TEXT);
 CREATE INDEX IF NOT EXISTS jobs_dispatch ON jobs(host_id,state,created);
 CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,actor TEXT NOT NULL,host_id TEXT NOT NULL,action TEXT NOT NULL,job_id TEXT NOT NULL,state TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS canary_sources(id TEXT PRIMARY KEY,config TEXT NOT NULL,token TEXT NOT NULL,payload TEXT NOT NULL DEFAULT '{}',collected INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT 'not_polled');
 CREATE TABLE IF NOT EXISTS mappings(host_id TEXT NOT NULL REFERENCES hosts(id),source_id TEXT NOT NULL REFERENCES canary_sources(id),monitor_id TEXT NOT NULL,PRIMARY KEY(host_id,source_id,monitor_id));
 CREATE TABLE IF NOT EXISTS agent_jobs(id TEXT PRIMARY KEY,state TEXT NOT NULL,result TEXT,created INTEGER NOT NULL);
 `)
	if err != nil {
		db.Close()
		return nil, err
	}
	if err = os.Chmod(path, 0600); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

type Sessions struct{ DB *sql.DB }

func (s *Sessions) Find(token string) ([]byte, bool, error) {
	var b []byte
	err := s.DB.QueryRow(`SELECT data FROM sessions WHERE token=? AND expiry>?`, token, time.Now().UnixMilli()).Scan(&b)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	return b, err == nil, err
}
func (s *Sessions) Commit(token string, b []byte, expiry time.Time) error {
	_, err := s.DB.Exec(`INSERT INTO sessions(token,data,expiry) VALUES(?,?,?) ON CONFLICT(token) DO UPDATE SET data=excluded.data,expiry=excluded.expiry`, token, b, expiry.UnixMilli())
	return err
}
func (s *Sessions) Delete(token string) error {
	_, err := s.DB.Exec(`DELETE FROM sessions WHERE token=?`, token)
	return err
}
