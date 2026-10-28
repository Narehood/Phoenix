package server

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/Narehood/Phoenix/internal/security"
	"github.com/Narehood/Phoenix/internal/store"
	"github.com/pquerna/otp/totp"
	"golang.org/x/crypto/bcrypt"
)

// These commands require local access to separately retained server keys and
// a stopped server. Nothing here is exposed through HTTP.
func RenewBootstrap(c Config) (string, error) {
	db, e := store.Open(filepath.Join(c.DataDir, "phoenix.db"))
	if e != nil {
		return "", e
	}
	defer db.Close()
	var count int
	if e = db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&count); e != nil {
		return "", e
	}
	if count != 0 {
		return "", errors.New("setup already completed; use offline administrator recovery")
	}
	token := security.Token()
	path := filepath.Join(c.IdentityDir, "setup-renewed.token")
	if e = security.WritePrivate(path, []byte(token)); e != nil {
		return "", e
	}
	_, e = db.Exec(`INSERT INTO setup(id,token_hash,expires) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash,expires=excluded.expires,name='',password=NULL,totp=''`, security.Hash(token), time.Now().Add(30*time.Minute).UnixMilli())
	return path, e
}
func RecoverAdmin(c Config, name string) (string, error) {
	if !validName.MatchString(name) {
		return "", errors.New("administrator account name required")
	}
	key, e := os.ReadFile(filepath.Join(c.IdentityDir, "encryption.key"))
	if e != nil {
		return "", e
	}
	vault, e := security.NewVault(key)
	if e != nil {
		return "", e
	}
	db, e := store.Open(filepath.Join(c.DataDir, "phoenix.db"))
	if e != nil {
		return "", e
	}
	defer db.Close()
	var id string
	if e = db.QueryRow(`SELECT id FROM users WHERE name=? AND role='admin'`, name).Scan(&id); e != nil {
		return "", errors.New("administrator not found")
	}
	password := security.Token()
	hash, e := bcrypt.GenerateFromPassword([]byte(password), 12)
	if e != nil {
		return "", e
	}
	secret, e := totp.Generate(totp.GenerateOpts{Issuer: "Phoenix", AccountName: name, SecretSize: 32})
	if e != nil {
		return "", e
	}
	credentials, _ := json.Marshal(map[string]string{"name": name, "password": password, "totpSecret": secret.Secret()})
	path := filepath.Join(c.IdentityDir, "admin-recovery.secret")
	if e = security.WritePrivate(path, credentials); e != nil {
		return "", e
	}
	tx, e := db.Begin()
	if e != nil {
		return "", e
	}
	defer tx.Rollback()
	if _, e = tx.Exec(`UPDATE users SET password=?,totp=?,totp_step=0,active=1 WHERE id=?; DELETE FROM sessions`, hash, vault.Seal(secret.Secret(), "totp:"+id), id); e != nil {
		return "", e
	}
	if _, e = tx.Exec(`INSERT INTO audit(at,actor,host_id,action,job_id,state) VALUES(?,'local-recovery','','admin.recover','','completed')`, time.Now().UnixMilli()); e != nil {
		return "", e
	}
	return path, tx.Commit()
}
