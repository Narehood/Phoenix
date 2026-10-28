package server

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Narehood/Phoenix/internal/core"
	"github.com/Narehood/Phoenix/internal/security"
	"github.com/Narehood/Phoenix/internal/store"
	"github.com/alexedwards/scs/v2"
)

type Config struct {
	DataDir     string `json:"dataDir"`
	IdentityDir string `json:"identityDir"`
	Origin      string `json:"origin"`
	WebListen   string `json:"webListen"`
	AgentListen string `json:"agentListen"`
	WebDir      string `json:"webDir"`
	TLSCert     string `json:"tlsCert"`
	TLSKey      string `json:"tlsKey"`
	CanaryFile  string `json:"canaryFile"`
}
type Server struct {
	DB          *sql.DB
	Config      Config
	CA          *security.CA
	Vault       *security.Vault
	Sessions    *scs.SessionManager
	mu          sync.Mutex
	connections map[net.Conn]string
	throttle    map[string]*attempt
	authGate    chan struct{}
	Now         core.Clock
}
type attempt struct {
	count int
	until time.Time
}
type publicError struct {
	code    int
	message string
}

func (e publicError) Error() string       { return e.message }
func fail(code int, message string) error { return publicError{code, message} }

func New(c Config) (*Server, error) {
	u, e := url.Parse(c.Origin)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" {
		return nil, errors.New("origin must be exact HTTPS origin without a path")
	}
	db, e := store.Open(filepath.Join(c.DataDir, "phoenix.db"))
	if e != nil {
		return nil, e
	}
	ca, e := security.LoadCA(c.IdentityDir)
	if e != nil {
		db.Close()
		return nil, e
	}
	key, e := os.ReadFile(filepath.Join(c.IdentityDir, "encryption.key"))
	if e != nil {
		db.Close()
		return nil, e
	}
	v, e := security.NewVault(key)
	if e != nil {
		db.Close()
		return nil, e
	}
	sessions := scs.New()
	sessions.Store = &store.Sessions{DB: db}
	sessions.Lifetime = 8 * time.Hour
	sessions.IdleTimeout = 30 * time.Minute
	sessions.Cookie.Name = "__Host-phoenix"
	sessions.Cookie.Secure = true
	sessions.Cookie.HttpOnly = true
	sessions.Cookie.SameSite = http.SameSiteStrictMode
	s := &Server{DB: db, Config: c, CA: ca, Vault: v, Sessions: sessions, connections: map[net.Conn]string{}, throttle: map[string]*attempt{}, authGate: make(chan struct{}, 2), Now: time.Now}
	// Dispatched jobs might already have executed; never automatically requeue.
	tx, e := db.Begin()
	if e != nil {
		db.Close()
		return nil, e
	}
	defer tx.Rollback()
	if _, e = tx.Exec(`INSERT INTO audit(at,actor,host_id,action,job_id,state) SELECT ?,actor,host_id,action,id,'uncertain:server_restart' FROM jobs WHERE state='dispatched'`, s.Now().UnixMilli()); e != nil {
		db.Close()
		return nil, e
	}
	if _, e = tx.Exec(`UPDATE jobs SET state='uncertain',finished=? WHERE state='dispatched'`, s.Now().UnixMilli()); e != nil {
		db.Close()
		return nil, e
	}
	if e = tx.Commit(); e != nil {
		db.Close()
		return nil, e
	}
	return s, nil
}

func Init(c Config) (string, error) {
	if e := os.MkdirAll(c.IdentityDir, 0700); e != nil {
		return "", e
	}
	if _, e := os.Stat(filepath.Join(c.IdentityDir, "ca.key")); !os.IsNotExist(e) {
		return "", errors.New("identity already initialized")
	}
	ca, e := security.NewCA()
	if e != nil {
		return "", e
	}
	if e = ca.Save(c.IdentityDir); e != nil {
		return "", e
	}
	key := make([]byte, 32)
	if _, e = rand.Read(key); e != nil {
		return "", e
	}
	if e = security.WritePrivate(filepath.Join(c.IdentityDir, "encryption.key"), key); e != nil {
		return "", e
	}
	u, e := url.Parse(c.Origin)
	if e != nil || u.Hostname() == "" {
		return "", errors.New("invalid HTTPS origin")
	}
	cert, k, e := ca.ServerCertificate([]string{u.Hostname(), "localhost", "127.0.0.1"})
	if e != nil {
		return "", e
	}
	if e = security.WritePrivate(filepath.Join(c.IdentityDir, "server.pem"), cert); e != nil {
		return "", e
	}
	if e = security.WritePrivate(filepath.Join(c.IdentityDir, "server.key"), k); e != nil {
		return "", e
	}
	db, e := store.Open(filepath.Join(c.DataDir, "phoenix.db"))
	if e != nil {
		return "", e
	}
	defer db.Close()
	token := security.Token()
	_, e = db.Exec(`INSERT INTO setup(id,token_hash,expires) VALUES(1,?,?)`, security.Hash(token), time.Now().Add(30*time.Minute).UnixMilli())
	if e != nil {
		return "", e
	}
	path := filepath.Join(c.IdentityDir, "setup.token")
	return path, security.WritePrivate(path, []byte(token))
}

func decode(r *http.Request, v any) error { return decodeLimit(r, v, 256*1024) }
func decodeLimit(r *http.Request, v any, limit int64) error {
	r.Body = http.MaxBytesReader(nil, r.Body, limit)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		return fail(400, "invalid request body")
	}
	if d.Decode(&struct{}{}) != io.EOF {
		return fail(400, "one JSON body required")
	}
	return nil
}
func write(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
func endpoint(fn func(http.ResponseWriter, *http.Request) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if e := fn(w, r); e != nil {
			var p publicError
			if errors.As(e, &p) {
				write(w, p.code, map[string]string{"error": p.message})
			} else {
				write(w, 503, map[string]string{"error": "operation unavailable"})
			}
		}
	}
}
func (s *Server) audit(tx *sql.Tx, actor, host, action, job, state string) error {
	_, e := tx.Exec(`INSERT INTO audit(at,actor,host_id,action,job_id,state) VALUES(?,?,?,?,?,?)`, s.Now().UnixMilli(), actor, host, action, job, state)
	return e
}

func (s *Server) WebHandler() http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("GET /api/auth/status", endpoint(s.authStatus))
	m.HandleFunc("POST /api/auth/setup/begin", endpoint(s.setupBegin))
	m.HandleFunc("POST /api/auth/setup/finish", endpoint(s.setupFinish))
	m.HandleFunc("POST /api/auth/login", endpoint(s.login))
	m.HandleFunc("GET /api/session", endpoint(s.session))
	m.HandleFunc("POST /api/auth/logout", s.require("", false, s.logout))
	m.HandleFunc("POST /api/auth/recent", s.require("", false, s.recent))
	m.HandleFunc("POST /api/auth/revoke-sessions", s.require("", true, s.revokeSessions))
	m.HandleFunc("GET /api/hosts", s.require("", false, s.listHosts))
	m.HandleFunc("GET /api/hosts/{host}", s.require("host.read", false, s.hostDetail))
	m.HandleFunc("PATCH /api/hosts/{host}", s.require("host.manage", false, s.updateHost))
	m.HandleFunc("POST /api/invitations", s.require("admin", true, s.invite))
	m.HandleFunc("POST /api/hosts/{host}/revoke", s.require("admin", true, s.revoke))
	m.HandleFunc("POST /api/hosts/{host}/approve", s.require("admin", true, s.approve))
	m.HandleFunc("GET /api/users", s.require("admin", false, s.users))
	m.HandleFunc("POST /api/users", s.require("admin", true, s.createUser))
	m.HandleFunc("PUT /api/users/{user}/grants", s.require("admin", true, s.setGrants))
	m.HandleFunc("POST /api/users/{user}/disable", s.require("admin", true, s.disableUser))
	m.HandleFunc("GET /api/jobs", s.require("", false, s.listJobs))
	m.HandleFunc("POST /api/hosts/{host}/jobs", s.require("", false, s.createJob))
	m.HandleFunc("GET /api/jobs/{job}", s.require("", false, s.getJob))
	m.HandleFunc("POST /api/jobs/{job}/cancel", s.require("", false, s.cancelJob))
	m.HandleFunc("GET /api/audit", s.require("", false, s.auditList))
	m.HandleFunc("GET /api/canary", s.require("", false, s.canaryList))
	m.HandleFunc("PUT /api/hosts/{host}/mappings", s.require("host.manage", false, s.setMappings))
	m.HandleFunc("GET /api/canary/{source}/monitors/{monitor}/history", s.require("", false, s.canaryHistory))
	m.HandleFunc("POST /enroll", endpoint(s.enroll))
	files := http.FileServer(http.Dir(s.Config.WebDir))
	m.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" && r.Method != "HEAD" {
			http.NotFound(w, r)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/.") {
			http.NotFound(w, r)
			return
		}
		files.ServeHTTP(w, r)
	})
	return s.headers(s.Sessions.LoadAndSave(m))
}
func (s *Server) headers(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Strict-Transport-Security", "max-age=31536000")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		if r.TLS == nil {
			write(w, 400, map[string]string{"error": "TLS required"})
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" && r.URL.Path != "/enroll" && r.Header.Get("Origin") != s.Config.Origin {
			write(w, 403, map[string]string{"error": "origin rejected"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) Serve(ctx context.Context) error {
	if e := s.LoadCanary(); e != nil {
		return e
	}
	roots := x509.NewCertPool()
	roots.AddCert(s.CA.Certificate)
	web := &http.Server{Addr: s.Config.WebListen, Handler: s.WebHandler(), TLSConfig: &tls.Config{MinVersion: tls.VersionTLS13}, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 20 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 * 1024}
	agent := &http.Server{Addr: s.Config.AgentListen, Handler: s.AgentHandler(), TLSConfig: &tls.Config{MinVersion: tls.VersionTLS13, ClientAuth: tls.RequireAndVerifyClientCert, ClientCAs: roots, SessionTicketsDisabled: true}, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 20 * time.Second, IdleTimeout: 20 * time.Second, MaxHeaderBytes: 16 * 1024}
	agent.ConnContext = func(ctx context.Context, c net.Conn) context.Context {
		s.mu.Lock()
		s.connections[c] = ""
		s.mu.Unlock()
		return context.WithValue(ctx, connKey{}, c)
	}
	agent.ConnState = func(c net.Conn, state http.ConnState) {
		if state == http.StateClosed || state == http.StateHijacked {
			s.mu.Lock()
			delete(s.connections, c)
			s.mu.Unlock()
		}
	}
	if s.Config.TLSCert == "" {
		s.Config.TLSCert = filepath.Join(s.Config.IdentityDir, "server.pem")
	}
	if s.Config.TLSKey == "" {
		s.Config.TLSKey = filepath.Join(s.Config.IdentityDir, "server.key")
	}
	errch := make(chan error, 2)
	go func() { errch <- web.ListenAndServeTLS(s.Config.TLSCert, s.Config.TLSKey) }()
	go func() { errch <- agent.ListenAndServeTLS(s.Config.TLSCert, s.Config.TLSKey) }()
	go s.maintenance(ctx)
	go s.pollCanary(ctx)
	select {
	case <-ctx.Done():
	case e := <-errch:
		if !errors.Is(e, http.ErrServerClosed) {
			_ = web.Close()
			_ = agent.Close()
			return e
		}
	}
	stop, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = web.Shutdown(stop)
	_ = agent.Shutdown(stop)
	return nil
}

type connKey struct{}

func (s *Server) closeHost(host string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for c, id := range s.connections {
		if id == host {
			_ = c.Close()
		}
	}
}
func (s *Server) maintenance(ctx context.Context) {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.sweep()
		}
	}
}
func (s *Server) sweep() {
	now := s.Now().UnixMilli()
	tx, e := s.DB.Begin()
	if e != nil {
		return
	}
	defer tx.Rollback()
	_, e = tx.Exec(`INSERT INTO audit(at,actor,host_id,action,job_id,state) SELECT ?,actor,host_id,action,id,CASE WHEN state='queued' THEN 'expired' ELSE 'uncertain:deadline' END FROM jobs WHERE (state='queued' AND expires<=?) OR (state='dispatched' AND deadline<=?)`, now, now, now)
	if e != nil {
		return
	}
	_, e = tx.Exec(`UPDATE jobs SET state=CASE WHEN state='queued' THEN 'expired' ELSE 'uncertain' END,finished=? WHERE (state='queued' AND expires<=?) OR (state='dispatched' AND deadline<=?)`, now, now, now)
	if e != nil {
		return
	}
	_, e = tx.Exec(`DELETE FROM sessions WHERE expiry<?; DELETE FROM invitations WHERE expires<?; DELETE FROM samples WHERE collected<?; DELETE FROM jobs WHERE finished>0 AND finished<?; DELETE FROM audit WHERE at<?`, now, now-86400000, now-86400000, now-30*86400000, now-90*86400000)
	if e == nil {
		_ = tx.Commit()
	}
}
