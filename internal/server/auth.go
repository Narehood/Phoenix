package server

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"net"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/Narehood/Phoenix/internal/core"
	"github.com/Narehood/Phoenix/internal/security"
	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
	"golang.org/x/crypto/bcrypt"
)

var validName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}$`)
var validService = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.@-]{0,100}\.service$`)
var actions = map[string]bool{"host.read": true, "host.manage": true, "diagnostic": true, "service.restart": true, "services.inspect": true, "logs.read": true, "host.reboot": true, "jobs.output": true, "jobs.cancel": true}

func passwordOK(p string) bool { return len(p) >= 14 && len(p) <= 72 }
func (s *Server) rate(r *http.Request) bool {
	ip, _, e := net.SplitHostPort(r.RemoteAddr)
	if e != nil {
		ip = r.RemoteAddr
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.Now()
	for k, a := range s.throttle {
		if now.After(a.until) {
			delete(s.throttle, k)
		}
	}
	a := s.throttle[ip]
	if a == nil {
		if len(s.throttle) >= 1024 {
			return false
		}
		a = &attempt{until: now.Add(5 * time.Minute)}
		s.throttle[ip] = a
	}
	a.count++
	return a.count <= 10
}
func (s *Server) authWork(r *http.Request) (func(), error) {
	if !s.rate(r) {
		return nil, fail(429, "authentication throttled")
	}
	select {
	case s.authGate <- struct{}{}:
		return func() { <-s.authGate }, nil
	default:
		return nil, fail(429, "authentication busy")
	}
}
func (s *Server) authStatus(w http.ResponseWriter, r *http.Request) error {
	var n int
	if e := s.DB.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n); e != nil {
		return e
	}
	write(w, 200, map[string]any{"setupRequired": n == 0, "mfaRequired": true})
	return nil
}
func (s *Server) checkSetup(token string) error {
	var hash string
	var expiry int64
	if e := s.DB.QueryRow(`SELECT token_hash,expires FROM setup WHERE id=1`).Scan(&hash, &expiry); e != nil || expiry < s.Now().UnixMilli() || subtle.ConstantTimeCompare([]byte(hash), []byte(security.Hash(token))) != 1 {
		return fail(403, "setup unavailable")
	}
	return nil
}
func (s *Server) setupBegin(w http.ResponseWriter, r *http.Request) error {
	done, e := s.authWork(r)
	if e != nil {
		return e
	}
	defer done()
	var b struct {
		Token    string `json:"token"`
		Name     string `json:"name"`
		Password string `json:"password"`
	}
	if e = decode(r, &b); e != nil {
		return e
	}
	if e = s.checkSetup(b.Token); e != nil {
		return e
	}
	if !validName.MatchString(b.Name) || !passwordOK(b.Password) {
		return fail(400, "name or password invalid (password: 14–72 bytes)")
	}
	hash, e := bcrypt.GenerateFromPassword([]byte(b.Password), 12)
	if e != nil {
		return e
	}
	key, e := totp.Generate(totp.GenerateOpts{Issuer: "Phoenix", AccountName: b.Name, SecretSize: 32})
	if e != nil {
		return e
	}
	_, e = s.DB.Exec(`UPDATE setup SET name=?,password=?,totp=? WHERE id=1`, b.Name, hash, s.Vault.Seal(key.Secret(), "setup"))
	if e != nil {
		return e
	}
	write(w, 200, map[string]string{"secret": key.Secret(), "instruction": "Add this secret to your authenticator as Phoenix, SHA1, 6 digits, 30 seconds; then confirm a code."})
	return nil
}
func stepFor(code, secret string, now time.Time) (int64, bool) {
	opts := totp.ValidateOpts{Period: 30, Skew: 1, Digits: otp.DigitsSix, Algorithm: otp.AlgorithmSHA1}
	ok, e := totp.ValidateCustom(code, secret, now, opts)
	if e != nil || !ok {
		return 0, false
	}
	for _, offset := range []int64{0, -1, 1} {
		step := now.Unix()/30 + offset
		c, e := totp.GenerateCodeCustom(secret, time.Unix(step*30, 0), opts)
		if e == nil && subtle.ConstantTimeCompare([]byte(c), []byte(code)) == 1 {
			return step, true
		}
	}
	return 0, false
}
func (s *Server) setupFinish(w http.ResponseWriter, r *http.Request) error {
	done, e := s.authWork(r)
	if e != nil {
		return e
	}
	defer done()
	var b struct {
		Token string `json:"token"`
		Code  string `json:"code"`
	}
	if e = decode(r, &b); e != nil {
		return e
	}
	if e = s.checkSetup(b.Token); e != nil {
		return e
	}
	var name, secret string
	var hash []byte
	if e = s.DB.QueryRow(`SELECT name,password,totp FROM setup WHERE id=1`).Scan(&name, &hash, &secret); e != nil {
		return e
	}
	secret, e = s.Vault.Open(secret, "setup")
	if e != nil {
		return fail(403, "begin setup first")
	}
	step, ok := stepFor(b.Code, secret, s.Now())
	if !ok {
		return fail(403, "invalid MFA code")
	}
	id := security.Token()
	tx, e := s.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var n int
	if e = tx.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n); e != nil {
		return e
	}
	if n != 0 {
		return fail(409, "already initialized")
	}
	_, e = tx.Exec(`INSERT INTO users(id,name,role,password,totp,totp_step) VALUES(?,?,'admin',?,?,?)`, id, name, hash, s.Vault.Seal(secret, "totp:"+id), step)
	if e != nil {
		return e
	}
	_, e = tx.Exec(`INSERT INTO grants VALUES(?,'all','*','*'); DELETE FROM setup`, id)
	if e != nil {
		return e
	}
	if e = s.audit(tx, id, "", "setup", "", "completed"); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	if e = s.startSession(r, id); e != nil {
		return e
	}
	write(w, 201, map[string]any{"user": core.User{ID: id, Name: name, Role: "admin", Active: true}, "csrfToken": s.Sessions.GetString(r.Context(), "csrf")})
	return nil
}
func (s *Server) authenticate(name, password, code string) (core.User, error) {
	var u core.User
	var hash []byte
	var encrypted string
	var last int64
	e := s.DB.QueryRow(`SELECT id,name,role,password,totp,totp_step,active FROM users WHERE name=?`, name).Scan(&u.ID, &u.Name, &u.Role, &hash, &encrypted, &last, &u.Active)
	if e != nil || !u.Active {
		return u, fail(401, "invalid credentials")
	}
	if bcrypt.CompareHashAndPassword(hash, []byte(password)) != nil {
		return u, fail(401, "invalid credentials")
	}
	secret, e := s.Vault.Open(encrypted, "totp:"+u.ID)
	if e != nil {
		return u, e
	}
	step, ok := stepFor(code, secret, s.Now())
	if !ok || step <= last {
		return u, fail(401, "invalid credentials or reused MFA code")
	}
	res, e := s.DB.Exec(`UPDATE users SET totp_step=? WHERE id=? AND totp_step<? AND active=1`, step, u.ID, step)
	if e != nil {
		return u, e
	}
	n, e := res.RowsAffected()
	if e != nil || n != 1 {
		return u, fail(401, "invalid credentials")
	}
	return u, nil
}
func (s *Server) startSession(r *http.Request, id string) error {
	if e := s.Sessions.RenewToken(r.Context()); e != nil {
		return e
	}
	s.Sessions.Put(r.Context(), "user", id)
	s.Sessions.Put(r.Context(), "csrf", security.Token())
	s.Sessions.Put(r.Context(), "recent", s.Now().Unix())
	return nil
}
func (s *Server) login(w http.ResponseWriter, r *http.Request) error {
	done, e := s.authWork(r)
	if e != nil {
		return e
	}
	defer done()
	var b struct {
		Name     string `json:"name"`
		Password string `json:"password"`
		Code     string `json:"code"`
	}
	if e = decode(r, &b); e != nil {
		return e
	}
	u, e := s.authenticate(b.Name, b.Password, b.Code)
	if e != nil {
		return e
	}
	if e = s.startSession(r, u.ID); e != nil {
		return e
	}
	write(w, 200, map[string]any{"user": u, "csrfToken": s.Sessions.GetString(r.Context(), "csrf")})
	return nil
}
func (s *Server) current(ctx context.Context) (core.User, error) {
	var u core.User
	id := s.Sessions.GetString(ctx, "user")
	e := s.DB.QueryRow(`SELECT id,name,role,active FROM users WHERE id=? AND active=1`, id).Scan(&u.ID, &u.Name, &u.Role, &u.Active)
	if e != nil {
		return u, fail(401, "sign in required")
	}
	return u, nil
}
func (s *Server) session(w http.ResponseWriter, r *http.Request) error {
	u, e := s.current(r.Context())
	if e != nil {
		return e
	}
	write(w, 200, map[string]any{"user": u, "csrfToken": s.Sessions.GetString(r.Context(), "csrf")})
	return nil
}
func (s *Server) require(action string, recent bool, fn func(http.ResponseWriter, *http.Request, core.User) error) http.HandlerFunc {
	return endpoint(func(w http.ResponseWriter, r *http.Request) error {
		u, e := s.current(r.Context())
		if e != nil {
			return e
		}
		if r.Method != "GET" && r.Method != "HEAD" {
			csrf := s.Sessions.GetString(r.Context(), "csrf")
			if csrf == "" || subtle.ConstantTimeCompare([]byte(csrf), []byte(r.Header.Get("X-CSRF-Token"))) != 1 {
				return fail(403, "CSRF token rejected")
			}
		}
		if recent && s.Now().Unix()-s.Sessions.GetInt64(r.Context(), "recent") > 300 {
			return fail(403, "recent password and MFA required")
		}
		if action == "admin" {
			if u.Role != "admin" {
				return fail(403, "administrator required")
			}
		} else if action != "" {
			ok, e := s.allowed(u.ID, r.PathValue("host"), action)
			if e != nil {
				return e
			}
			if !ok {
				return fail(403, "action forbidden")
			}
		}
		return fn(w, r, u)
	})
}
func (s *Server) allowed(user, host, action string) (bool, error) {
	return allowedDB(s.DB, user, host, action)
}

type querier interface {
	QueryRow(string, ...any) *sql.Row
	Query(string, ...any) (*sql.Rows, error)
}

func allowedDB(q querier, user, host, action string) (bool, error) {
	if !actions[action] {
		return false, nil
	}
	var role string
	var active bool
	if e := q.QueryRow(`SELECT role,active FROM users WHERE id=?`, user).Scan(&role, &active); e != nil {
		return false, e
	}
	if !active {
		return false, nil
	}
	if role == "viewer" && action != "host.read" {
		return false, nil
	}
	if role != "admin" && role != "operator" && role != "viewer" {
		return false, nil
	}
	var groups string
	if host != "" {
		if e := q.QueryRow(`SELECT groups_json FROM hosts WHERE id=?`, host).Scan(&groups); e != nil {
			return false, nil
		}
	}
	var n int
	e := q.QueryRow(`SELECT COUNT(*) FROM grants WHERE user_id=? AND (action=? OR action='*') AND ((scope_type='all' AND scope='*') OR (scope_type='host' AND scope=?) OR (scope_type='group' AND scope IN(SELECT value FROM json_each(?))))`, user, action, host, groupsOrEmpty(groups)).Scan(&n)
	return n > 0, e
}
func groupsOrEmpty(s string) string {
	if s == "" {
		return "[]"
	}
	return s
}
func (s *Server) logout(w http.ResponseWriter, r *http.Request, u core.User) error {
	if e := s.Sessions.Destroy(r.Context()); e != nil {
		return e
	}
	write(w, 200, map[string]bool{"signedOut": true})
	return nil
}
func (s *Server) recent(w http.ResponseWriter, r *http.Request, u core.User) error {
	done, e := s.authWork(r)
	if e != nil {
		return e
	}
	defer done()
	var b struct {
		Password string `json:"password"`
		Code     string `json:"code"`
	}
	if e = decode(r, &b); e != nil {
		return e
	}
	if _, e = s.authenticate(u.Name, b.Password, b.Code); e != nil {
		return e
	}
	s.Sessions.Put(r.Context(), "recent", s.Now().Unix())
	write(w, 200, map[string]bool{"recent": true})
	return nil
}
func (s *Server) revokeSessions(w http.ResponseWriter, r *http.Request, u core.User) error {
	if u.Role != "admin" {
		return fail(403, "administrator required")
	}
	tx, e := s.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if _, e = tx.Exec(`DELETE FROM sessions`); e != nil {
		return e
	}
	if e = s.audit(tx, u.ID, "", "sessions.revoke", "", "completed"); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	return s.logout(w, r, u)
}
func (s *Server) users(w http.ResponseWriter, r *http.Request, u core.User) error {
	rows, e := s.DB.Query(`SELECT id,name,role,active FROM users ORDER BY name LIMIT 100`)
	if e != nil {
		return e
	}
	defer rows.Close()
	out := []core.User{}
	for rows.Next() {
		var v core.User
		if e = rows.Scan(&v.ID, &v.Name, &v.Role, &v.Active); e != nil {
			return e
		}
		out = append(out, v)
	}
	write(w, 200, out)
	return rows.Err()
}
func (s *Server) createUser(w http.ResponseWriter, r *http.Request, u core.User) error {
	var b struct {
		Name     string `json:"name"`
		Role     string `json:"role"`
		Password string `json:"password"`
	}
	if e := decode(r, &b); e != nil {
		return e
	}
	if !validName.MatchString(b.Name) || !passwordOK(b.Password) || (b.Role != "viewer" && b.Role != "operator") {
		return fail(400, "invalid account; use viewer or operator and a 14–72 byte password")
	}
	hash, e := bcrypt.GenerateFromPassword([]byte(b.Password), 12)
	if e != nil {
		return e
	}
	key, e := totp.Generate(totp.GenerateOpts{Issuer: "Phoenix", AccountName: b.Name, SecretSize: 32})
	if e != nil {
		return e
	}
	id := security.Token()
	tx, e := s.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var n int
	if e = tx.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n); e != nil {
		return e
	}
	if n >= 100 {
		return fail(409, "account capacity reached")
	}
	_, e = tx.Exec(`INSERT INTO users(id,name,role,password,totp) VALUES(?,?,?,?,?)`, id, b.Name, b.Role, hash, s.Vault.Seal(key.Secret(), "totp:"+id))
	if e != nil {
		return fail(409, "account unavailable")
	}
	if e = s.audit(tx, u.ID, "", "account.create", "", "completed"); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	write(w, 201, map[string]any{"user": core.User{ID: id, Name: b.Name, Role: b.Role, Active: true}, "secret": key.Secret(), "note": "Share through a trusted channel. Account has no host grants yet."})
	return nil
}
func (s *Server) setGrants(w http.ResponseWriter, r *http.Request, u core.User) error {
	var b struct {
		Grants []core.Grant `json:"grants"`
	}
	if e := decode(r, &b); e != nil {
		return e
	}
	if len(b.Grants) > 100 {
		return fail(400, "too many grants")
	}
	id := r.PathValue("user")
	if id == u.ID {
		return fail(400, "cannot replace your own administrator grants")
	}
	for _, g := range b.Grants {
		if !(actions[g.Action] || g.Action == "*") || !(g.ScopeType == "host" || g.ScopeType == "group" || g.ScopeType == "all") || g.Scope == "" || len(g.Scope) > 80 || (g.ScopeType == "all" && g.Scope != "*") {
			return fail(400, "invalid grant")
		}
	}
	tx, e := s.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var role string
	if e = tx.QueryRow(`SELECT role FROM users WHERE id=?`, id).Scan(&role); e != nil {
		return fail(404, "user not found")
	}
	if role == "admin" {
		return fail(403, "administrator grants are maintained offline")
	}
	if _, e = tx.Exec(`DELETE FROM grants WHERE user_id=?`, id); e != nil {
		return e
	}
	for _, g := range b.Grants {
		if _, e = tx.Exec(`INSERT INTO grants VALUES(?,?,?,?)`, id, g.ScopeType, g.Scope, g.Action); e != nil {
			return e
		}
	}
	if e = s.audit(tx, u.ID, "", "grants.replace", "", "completed"); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	write(w, 200, b)
	return nil
}
func (s *Server) disableUser(w http.ResponseWriter, r *http.Request, u core.User) error {
	id := r.PathValue("user")
	if id == u.ID {
		return fail(400, "cannot disable yourself")
	}
	tx, e := s.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	res, e := tx.Exec(`UPDATE users SET active=0 WHERE id=? AND role<>'admin'`, id)
	if e != nil {
		return e
	}
	n, _ := res.RowsAffected()
	if n != 1 {
		return fail(404, "non-admin user not found")
	}
	if _, e = tx.Exec(`DELETE FROM sessions`); e != nil {
		return e
	}
	if e = s.audit(tx, u.ID, "", "account.disable", "", "completed"); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	if e = s.Sessions.Destroy(r.Context()); e != nil {
		return e
	}
	write(w, 200, map[string]bool{"disabled": true})
	return nil
}
func cleanStrings(xs []string) bool {
	if len(xs) > 20 {
		return false
	}
	for _, x := range xs {
		if !validName.MatchString(x) || strings.TrimSpace(x) != x {
			return false
		}
	}
	return true
}
