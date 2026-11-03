package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode"

	"github.com/Narehood/Phoenix/internal/core"
	gh "github.com/Narehood/Phoenix/internal/github"
)

const githubInterval = 15 * time.Minute

type githubSource struct {
	Project, Repository, Token, Payload, Error string
	Enabled                                    bool
	Revision, Attempt, Collected, Next         int64
}

type githubView struct {
	Configured    bool         `json:"configured"`
	Repository    string       `json:"repository"`
	Enabled       bool         `json:"enabled"`
	Revision      int64        `json:"revision"`
	State         string       `json:"state"`
	Freshness     string       `json:"freshness"`
	Error         string       `json:"error"`
	LastAttemptAt int64        `json:"lastAttemptAt"`
	CollectedAt   int64        `json:"collectedAt"`
	NextAttemptAt int64        `json:"nextAttemptAt"`
	Snapshot      *gh.Snapshot `json:"snapshot"`
}

const githubColumns = `project_id,repository,token,payload,error,enabled,revision,attempt,collected,next_attempt`

func scanGitHub(row interface{ Scan(...any) error }) (githubSource, error) {
	var g githubSource
	e := row.Scan(&g.Project, &g.Repository, &g.Token, &g.Payload, &g.Error, &g.Enabled, &g.Revision, &g.Attempt, &g.Collected, &g.Next)
	return g, e
}

func (s *Server) githubAccess(q querier, u core.User, id, action string) (core.Project, error) {
	p, e := readProject(q, u.ID, id)
	if e != nil {
		return p, e
	}
	ok, e := projectAllowed(q, u.ID, id, action)
	if e != nil {
		return p, e
	}
	if !ok {
		return p, fail(403, "GitHub access forbidden")
	}
	return p, nil
}

func dependenciesEnabled(p core.Project) bool {
	if p.Archived {
		return false
	}
	for _, m := range p.Modules {
		if m == "dependencies" {
			return true
		}
	}
	return false
}

func (s *Server) githubView(p core.Project, g githubSource) (githubView, error) {
	v := githubView{Configured: g.Token != "", Repository: g.Repository, Enabled: g.Enabled, Revision: g.Revision, State: "not_configured", Freshness: "unknown", Error: g.Error, LastAttemptAt: g.Attempt, CollectedAt: g.Collected, NextAttemptAt: g.Next}
	if !v.Configured {
		return v, nil
	}
	v.State = "pending"
	if g.Payload != "" {
		var snapshot gh.Snapshot
		if e := json.Unmarshal([]byte(g.Payload), &snapshot); e != nil {
			return v, e
		}
		v.Snapshot = &snapshot
	}
	if g.Collected > 0 {
		v.State = "fresh"
		v.Freshness = "fresh"
		if g.Error != "" || s.Now().UnixMilli()-g.Collected > int64(2*githubInterval/time.Millisecond) {
			v.State = "stale"
			v.Freshness = "stale"
		}
		if v.State == "fresh" && v.Snapshot != nil && githubPartial(*v.Snapshot) {
			v.State = "partial"
		}
	}
	if g.Error != "" {
		v.State = g.Error
	}
	if !g.Enabled || !dependenciesEnabled(p) {
		v.State = "disabled"
		v.Freshness = "stale"
		if g.Collected == 0 {
			v.Freshness = "unknown"
		}
	}
	return v, nil
}

func githubPartial(s gh.Snapshot) bool {
	// CI is a recent-history window: older runs beyond that window are expected.
	if s.Pulls.State != "ok" || s.Pulls.Truncated || s.DefaultBranchCI.State != "ok" || s.Alerts.State != "ok" || s.Alerts.Truncated {
		return true
	}
	for _, p := range s.Pulls.Items {
		if p.Checks == "partial" || p.Checks == "unknown" || p.ReviewState == "partial" || p.ReviewState == "unknown" {
			return true
		}
	}
	return false
}

func (s *Server) getGitHub(w http.ResponseWriter, r *http.Request, u core.User) error {
	p, e := s.githubAccess(s.DB, u, r.PathValue("project"), "github.read")
	if e != nil {
		return e
	}
	g, e := scanGitHub(s.DB.QueryRow(`SELECT `+githubColumns+` FROM github_sources WHERE project_id=?`, p.ID))
	if e != nil && e != sql.ErrNoRows {
		return e
	}
	v, e := s.githubView(p, g)
	if e != nil {
		return e
	}
	write(w, 200, v)
	return nil
}

func validGitHubToken(token string) bool {
	if len(token) < 20 || len(token) > 255 {
		return false
	}
	for _, c := range token {
		if c > unicode.MaxASCII || !unicode.IsPrint(c) || unicode.IsSpace(c) {
			return false
		}
	}
	return true
}

func (s *Server) configureGitHub(w http.ResponseWriter, r *http.Request, u core.User) error {
	var b struct {
		Repository string `json:"repository"`
		Token      string `json:"token"`
		Enabled    bool   `json:"enabled"`
		Revision   int64  `json:"revision"`
	}
	if e := decodeLimit(r, &b, 2048); e != nil {
		return e
	}
	if !gh.ValidRepository(b.Repository) || b.Revision < 0 || b.Token != "" && !validGitHubToken(b.Token) {
		return fail(400, "invalid GitHub configuration")
	}
	tx, e := s.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	p, e := readProject(tx, u.ID, r.PathValue("project"))
	if e != nil {
		return e
	}
	if b.Enabled && !dependenciesEnabled(p) {
		return fail(409, "enable the dependencies module on an active project first")
	}
	g, e := scanGitHub(tx.QueryRow(`SELECT `+githubColumns+` FROM github_sources WHERE project_id=?`, p.ID))
	if e != nil && e != sql.ErrNoRows {
		return e
	}
	if g.Revision != b.Revision {
		return fail(409, "GitHub configuration changed; reload before saving")
	}
	if g.Token == "" {
		var n int
		if e = tx.QueryRow(`SELECT COUNT(*) FROM github_sources WHERE token<>''`).Scan(&n); e != nil {
			return e
		}
		if n >= 16 {
			return fail(409, "GitHub source capacity reached (16)")
		}
	}
	if b.Token == "" {
		if g.Token == "" || !strings.EqualFold(g.Repository, b.Repository) {
			return fail(400, "a token is required for a new repository")
		}
	} else {
		g.Token = s.Vault.Seal(b.Token, "github:"+p.ID)
	}
	// Clear prior observations on any credential/configuration change. A response
	// collected in flight can commit only against its original source revision.
	if _, e = tx.Exec(`INSERT INTO github_sources(project_id,repository,token,enabled,revision) VALUES(?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET repository=excluded.repository,token=excluded.token,enabled=excluded.enabled,revision=excluded.revision,payload='',error='',attempt=0,collected=0,next_attempt=0`, p.ID, b.Repository, g.Token, b.Enabled, g.Revision+1); e != nil {
		return e
	}
	if e = s.auditProject(tx, u.ID, p.ID, "github.configure"); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	s.wakeGitHub()
	write(w, 200, map[string]any{"configured": true, "revision": g.Revision + 1})
	return nil
}

func (s *Server) deleteGitHub(w http.ResponseWriter, r *http.Request, u core.User) error {
	var b struct {
		Revision int64 `json:"revision"`
	}
	if e := decodeLimit(r, &b, 1024); e != nil {
		return e
	}
	tx, e := s.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	p, e := readProject(tx, u.ID, r.PathValue("project"))
	if e != nil {
		return e
	}
	// Retain only a revision tombstone. Deleting the revision would let an old
	// browser tab mutate a later connection after its counter restarted at one.
	res, e := tx.Exec(`UPDATE github_sources SET repository='',token='',enabled=0,revision=revision+1,payload='',error='',attempt=0,collected=0,next_attempt=0 WHERE project_id=? AND revision=? AND token<>''`, p.ID, b.Revision)
	if e != nil {
		return e
	}
	n, e := res.RowsAffected()
	if e != nil {
		return e
	}
	if n != 1 {
		return fail(409, "GitHub configuration changed; reload before disconnecting")
	}
	if e = s.auditProject(tx, u.ID, p.ID, "github.disconnect"); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	write(w, 200, map[string]any{"disconnected": true, "revision": b.Revision + 1})
	return nil
}

func (s *Server) syncGitHub(w http.ResponseWriter, r *http.Request, u core.User) error {
	tx, e := s.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	p, e := s.githubAccess(tx, u, r.PathValue("project"), "github.sync")
	if e != nil {
		return e
	}
	// Reading results is a separate prerequisite for requesting collection.
	if _, e = s.githubAccess(tx, u, p.ID, "github.read"); e != nil {
		return e
	}
	g, e := scanGitHub(tx.QueryRow(`SELECT `+githubColumns+` FROM github_sources WHERE project_id=?`, p.ID))
	if e == sql.ErrNoRows {
		return fail(409, "GitHub is not configured")
	}
	if e != nil {
		return e
	}
	if !g.Enabled || !dependenciesEnabled(p) {
		return fail(409, "GitHub source or dependency module is disabled")
	}
	if g.Next > s.Now().UnixMilli() {
		return fail(429, "GitHub refresh is cooling down; check nextAttemptAt")
	}
	if e = s.auditProject(tx, u.ID, p.ID, "github.sync_requested"); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	s.wakeGitHub()
	write(w, 202, map[string]bool{"scheduled": true})
	return nil
}

func (s *Server) wakeGitHub() {
	select {
	case s.githubWake <- struct{}{}:
	default:
	}
}

func (s *Server) pollGitHub(ctx context.Context) {
	tick := time.NewTicker(5 * time.Second)
	defer tick.Stop()
	for {
		if ctx.Err() != nil {
			return
		}
		rows, e := s.DB.Query(`SELECT g.`+strings.ReplaceAll(githubColumns, ",", ",g.")+` FROM github_sources g JOIN projects p ON p.id=g.project_id WHERE g.enabled=1 AND p.archived=0 AND EXISTS(SELECT 1 FROM json_each(p.modules) WHERE value='dependencies') AND g.next_attempt<=? ORDER BY g.next_attempt,g.project_id LIMIT 16`, s.Now().UnixMilli())
		if e == nil {
			sources := []githubSource{}
			for rows.Next() {
				g, err := scanGitHub(rows)
				if err != nil {
					e = err
					break
				}
				sources = append(sources, g)
			}
			if e == nil {
				e = rows.Err()
			}
			rows.Close()
			if e == nil {
				for _, g := range sources {
					if ctx.Err() != nil {
						return
					}
					s.collectGitHub(ctx, g)
				}
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		case <-s.githubWake:
		}
	}
}

func (s *Server) collectGitHub(ctx context.Context, g githubSource) {
	now := s.Now().UnixMilli()
	// Claim before network work; the durable cooldown survives server restarts.
	res, e := s.DB.Exec(`UPDATE github_sources SET attempt=?,next_attempt=? WHERE project_id=? AND revision=? AND token=? AND next_attempt<=? AND enabled=1 AND EXISTS(SELECT 1 FROM projects p WHERE p.id=project_id AND p.archived=0 AND EXISTS(SELECT 1 FROM json_each(p.modules) WHERE value='dependencies'))`, now, now+githubInterval.Milliseconds(), g.Project, g.Revision, g.Token, now)
	if e != nil {
		return
	}
	n, e := res.RowsAffected()
	if e != nil || n != 1 {
		return
	}
	token, e := s.Vault.Open(g.Token, "github:"+g.Project)
	var snapshot gh.Snapshot
	if e == nil {
		client := gh.New(token, s.githubTransport)
		defer client.Close()
		limited, cancel := context.WithTimeout(ctx, 60*time.Second)
		defer cancel()
		snapshot, e = client.Collect(limited, g.Repository)
	}
	state := ""
	next := now + githubInterval.Milliseconds()
	if e != nil {
		state = "unavailable"
		var api *gh.APIError
		if errors.As(e, &api) {
			state = api.State
			next = max(next, api.RetryAt)
		}
	}
	payload, collected := g.Payload, g.Collected
	if snapshot.Repository.FullName != "" {
		payload = core.Encode(snapshot)
		collected = s.Now().UnixMilli()
	}
	if len(payload) > 256*1024 {
		state = "invalid_response"
		payload, collected = g.Payload, g.Collected
	}
	// Source revision AND token prevent ABA after disconnect/reconnect. Disabled,
	// archived or removed modules also suppress a late in-flight result.
	_, _ = s.DB.Exec(`UPDATE github_sources SET payload=?,collected=?,error=?,next_attempt=? WHERE project_id=? AND revision=? AND token=? AND enabled=1 AND EXISTS(SELECT 1 FROM projects p WHERE p.id=project_id AND p.archived=0 AND EXISTS(SELECT 1 FROM json_each(p.modules) WHERE value='dependencies'))`, payload, collected, state, next, g.Project, g.Revision, g.Token)
}
