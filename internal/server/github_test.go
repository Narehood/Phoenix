package server

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Narehood/Phoenix/internal/core"
	gh "github.com/Narehood/Phoenix/internal/github"
	"github.com/pquerna/otp/totp"
)

type githubFixtureTransport func(*http.Request) (*http.Response, error)

func (f githubFixtureTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

const githubFixtureToken = "fixture-only-token-not-a-real-github-credential"

func githubFixtureResponse(r *http.Request) *http.Response {
	body := "[]"
	switch {
	case r.URL.Path == "/repos/example/repo":
		body = `{"full_name":"example/repo","default_branch":"main","private":true}`
	case strings.HasSuffix(r.URL.Path, "/actions/runs"):
		body = `{"total_count":0,"workflow_runs":[]}`
	}
	return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}
}

func fixtureGitHubSource(t *testing.T, f *fixture, id string) githubSource {
	t.Helper()
	g, e := scanGitHub(f.s.DB.QueryRow(`SELECT `+githubColumns+` FROM github_sources WHERE project_id=?`, id))
	if e != nil {
		t.Fatal(e)
	}
	return g
}

func TestGitHubLifecycleCredentialsFreshnessAndCooldown(t *testing.T) {
	f := newFixture(t)
	f.call("POST", "/api/projects", map[string]any{"id": "github-project", "name": "GitHub project", "modules": []string{"dependencies"}}, 201, nil)
	path := "/api/projects/github-project/github"
	var view githubView
	f.call("GET", path, nil, 200, &view)
	if view.Configured || view.State != "not_configured" || view.Snapshot != nil {
		t.Fatal("empty install contains source state")
	}
	body := map[string]any{"repository": "example/repo", "token": githubFixtureToken, "enabled": true, "revision": 0}
	f.request(f.browser, f.web.URL, "PUT", path, body, 403, nil, "")
	f.call("PUT", path, body, 200, nil)
	f.call("PUT", path, body, 409, nil)
	g := fixtureGitHubSource(t, f, "github-project")
	if g.Token == githubFixtureToken || strings.Contains(g.Token, githubFixtureToken) {
		t.Fatal("token stored without encryption")
	}
	plain, e := f.s.Vault.Open(g.Token, "github:github-project")
	if e != nil || plain != githubFixtureToken {
		t.Fatal("encrypted source token cannot be recovered")
	}
	var calls atomic.Int32
	var outage atomic.Bool
	f.s.githubTransport = githubFixtureTransport(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		if r.Method != "GET" || r.URL.Host != "api.github.com" || r.Header.Get("Authorization") != "Bearer "+githubFixtureToken {
			t.Error("source contract changed")
		}
		if outage.Load() {
			res := githubFixtureResponse(r)
			res.StatusCode = 401
			return res, nil
		}
		return githubFixtureResponse(r), nil
	})
	f.call("POST", path+"/sync", map[string]any{}, 202, nil)
	f.s.collectGitHub(context.Background(), g)
	f.call("GET", path, nil, 200, &view)
	if view.State != "fresh" || view.Freshness != "fresh" || view.Snapshot == nil || view.CollectedAt != f.now.UnixMilli() || calls.Load() != 4 {
		t.Fatal("first source collection failed", view, calls.Load())
	}
	if strings.Contains(core.Encode(view), githubFixtureToken) {
		t.Fatal("API leaked a credential")
	}
	f.call("POST", path+"/sync", map[string]any{}, 429, nil)
	f.s.collectGitHub(context.Background(), fixtureGitHubSource(t, f, "github-project"))
	if calls.Load() != 4 {
		t.Fatal("cooldown allowed duplicate outbound work")
	}
	f.advance(31 * time.Minute)
	f.call("GET", path, nil, 200, &view)
	if view.State != "stale" || view.Freshness != "stale" {
		t.Fatal("observation never aged")
	}
	outage.Store(true)
	f.s.collectGitHub(context.Background(), fixtureGitHubSource(t, f, "github-project"))
	f.call("GET", path, nil, 200, &view)
	if view.State != "credential_expired" || view.Freshness != "stale" || view.Snapshot == nil || view.Snapshot.Repository.FullName != "example/repo" {
		t.Fatal("outage discarded useful observations or stayed healthy", view)
	}
	// Refresh administrator authentication without reading any retained identity.
	code, e := totp.GenerateCode(f.secret, f.now)
	if e != nil {
		t.Fatal(e)
	}
	f.call("POST", "/api/auth/recent", map[string]string{"password": "fixture password long enough", "code": code}, 200, nil)
	f.call("PUT", path, map[string]any{"repository": "other/repo", "enabled": true, "revision": 1}, 400, nil)
	f.call("DELETE", path, map[string]int{"revision": 2}, 409, nil)
	f.call("DELETE", path, map[string]int{"revision": 1}, 200, nil)
	f.call("GET", path, nil, 200, &view)
	if view.Configured || view.Snapshot != nil {
		t.Fatal("disconnect retained public source data")
	}
}

func TestGitHubScopesAndGrantReadPreservation(t *testing.T) {
	f := newFixture(t)
	f.call("POST", "/api/projects", map[string]any{"id": "scoped", "name": "Scoped", "modules": []string{"dependencies"}}, 201, nil)
	path := "/api/projects/scoped/github"
	f.call("PUT", path, map[string]any{"repository": "example/repo", "token": githubFixtureToken, "enabled": true, "revision": 0}, 200, nil)
	var account struct {
		User   core.User `json:"user"`
		Secret string    `json:"secret"`
	}
	password := "github fixture password"
	f.call("POST", "/api/users", map[string]string{"name": "github-operator", "role": "operator", "password": password}, 201, &account)
	jar, _ := cookiejar.New(nil)
	operator := &http.Client{Transport: f.browser.Transport, Jar: jar, Timeout: 5 * time.Second}
	code, e := totp.GenerateCode(account.Secret, f.now)
	if e != nil {
		t.Fatal(e)
	}
	var auth struct {
		CSRF string `json:"csrfToken"`
	}
	f.request(operator, f.web.URL, "POST", "/api/auth/login", map[string]string{"name": account.User.Name, "password": password, "code": code}, 200, &auth, "")
	grants := []core.Grant{{ScopeType: "all", Scope: "*", Action: "*"}, {ScopeType: "project", Scope: "scoped", Action: "project.read"}, {ScopeType: "project", Scope: "scoped", Action: "project.manage"}}
	set := func() {
		f.replaceGrants(account.User.ID, grants)
	}
	set()
	f.request(operator, f.web.URL, "GET", path, nil, 403, nil, "")
	f.request(operator, f.web.URL, "POST", path+"/sync", map[string]any{}, 403, nil, auth.CSRF)
	grants = append(grants, core.Grant{ScopeType: "project", Scope: "scoped", Action: "github.read"})
	set()
	f.request(operator, f.web.URL, "GET", path, nil, 200, nil, "")
	f.request(operator, f.web.URL, "POST", path+"/sync", map[string]any{}, 403, nil, auth.CSRF)
	grants = append(grants, core.Grant{ScopeType: "project", Scope: "scoped", Action: "github.sync"})
	set()
	f.request(operator, f.web.URL, "POST", path+"/sync", map[string]any{}, 202, nil, auth.CSRF)
	f.request(operator, f.web.URL, "DELETE", path, map[string]int{"revision": 1}, 403, nil, auth.CSRF)
	f.request(operator, f.web.URL, "PUT", path, map[string]any{"repository": "example/repo", "enabled": false, "revision": 1}, 403, nil, auth.CSRF)
	var current struct {
		Grants []core.Grant `json:"grants"`
	}
	f.call("GET", "/api/users/"+account.User.ID+"/grants", nil, 200, &current)
	if len(current.Grants) != len(grants) {
		t.Fatal("grant editor cannot retrieve the complete mixed grant set")
	}
	f.request(operator, f.web.URL, "GET", "/api/users/"+account.User.ID+"/grants", nil, 403, nil, "")
	if _, e = f.s.DB.Exec(`UPDATE users SET role='viewer' WHERE id=?`, account.User.ID); e != nil {
		t.Fatal(e)
	}
	f.request(operator, f.web.URL, "GET", path, nil, 200, nil, "")
	f.request(operator, f.web.URL, "POST", path+"/sync", map[string]any{}, 403, nil, auth.CSRF)
	grants = grants[:1]
	set()
	f.request(operator, f.web.URL, "GET", path, nil, 404, nil, "")
}

func TestGitHubLateResultsAndDisabledCollection(t *testing.T) {
	f := newFixture(t)
	f.call("POST", "/api/projects", map[string]any{"id": "late", "name": "Late", "modules": []string{"dependencies"}}, 201, nil)
	path := "/api/projects/late/github"
	configure := func(revision int) {
		f.call("PUT", path, map[string]any{"repository": "example/repo", "token": githubFixtureToken, "enabled": true, "revision": revision}, 200, nil)
	}
	configure(0)
	started, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	f.s.githubTransport = githubFixtureTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/repos/example/repo" {
			close(started)
			select {
			case <-release:
			case <-r.Context().Done():
				return nil, r.Context().Err()
			}
		}
		return githubFixtureResponse(r), nil
	})
	g := fixtureGitHubSource(t, f, "late")
	go func() { defer close(done); f.s.collectGitHub(context.Background(), g) }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("fixture collection did not start")
	}
	f.call("DELETE", path, map[string]int{"revision": 1}, 200, nil)
	configure(2) // The disconnect retained a monotonically increasing revision.
	close(release)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("fixture collection did not finish")
	}
	oldSource := g
	g = fixtureGitHubSource(t, f, "late")
	if g.Payload != "" || g.Collected != 0 || g.Next != 0 {
		t.Fatal("late deleted-source result populated a new source")
	}
	var calls atomic.Int32
	f.s.githubTransport = githubFixtureTransport(func(r *http.Request) (*http.Response, error) { calls.Add(1); return githubFixtureResponse(r), nil })
	f.s.collectGitHub(context.Background(), oldSource)
	if calls.Load() != 0 {
		t.Fatal("deleted source snapshot claimed a reconnected source")
	}
	f.call("PUT", "/api/projects/late", map[string]any{"name": "Late", "modules": []string{"dependencies"}, "archived": true, "revision": 1}, 200, nil)
	f.s.collectGitHub(context.Background(), g)
	if calls.Load() != 0 {
		t.Fatal("archived project caused network work")
	}
	f.call("PUT", path, map[string]any{"repository": "example/repo", "enabled": true, "revision": 3}, 409, nil)
	f.call("PUT", path, map[string]any{"repository": "example/repo", "enabled": false, "revision": 3}, 200, nil)
	var view githubView
	f.call("GET", path, nil, 200, &view)
	if view.State != "disabled" {
		t.Fatal("disabled state lost")
	}
}

func TestGitHubDisconnectedRevisionCannotMutateReconnection(t *testing.T) {
	f := newFixture(t)
	f.call("POST", "/api/projects", map[string]any{"id": "generation", "name": "Generation", "modules": []string{"dependencies"}}, 201, nil)
	path := "/api/projects/generation/github"
	configure := func(repo string, revision, status int) {
		f.call("PUT", path, map[string]any{"repository": repo, "token": githubFixtureToken, "enabled": true, "revision": revision}, status, nil)
	}
	configure("example/repo", 0, 200)
	for _, repo := range []string{"example/repo", "other/repository"} {
		before := fixtureGitHubSource(t, f, "generation")
		f.call("DELETE", path, map[string]int64{"revision": before.Revision}, 200, nil)
		var view githubView
		f.call("GET", path, nil, 200, &view)
		if view.Configured || view.Revision != before.Revision+1 || view.Repository != "" || view.Snapshot != nil {
			t.Fatal("disconnect did not expose an empty revision tombstone", view)
		}
		cleared := fixtureGitHubSource(t, f, "generation")
		if cleared.Token != "" || cleared.Payload != "" || cleared.Enabled {
			t.Fatal("disconnect retained a credential or observation")
		}
		configure(repo, 0, 409)
		configure(repo, int(view.Revision), 200)
		reconnected := fixtureGitHubSource(t, f, "generation")
		configure("example/repo", int(before.Revision), 409)
		f.call("DELETE", path, map[string]int64{"revision": before.Revision}, 409, nil)
		after := fixtureGitHubSource(t, f, "generation")
		if after.Repository != repo || after.Revision != reconnected.Revision || after.Token != reconnected.Token {
			t.Fatal("stale tab mutated a reconnected source")
		}
	}
}

func TestGitHubRecentCIWindowDoesNotMeanPartial(t *testing.T) {
	s := gh.Snapshot{Pulls: gh.Collection[gh.Pull]{State: "ok"}, DefaultBranchCI: gh.Collection[gh.Workflow]{State: "ok", Truncated: true}, Alerts: gh.Collection[gh.Alert]{State: "ok"}}
	if githubPartial(s) || !s.DefaultBranchCI.Truncated {
		t.Fatal("expected CI history window marked the source partial or lost its bound")
	}
	s.DefaultBranchCI.State = "permission_denied"
	if !githubPartial(s) {
		t.Fatal("unreadable recent CI window looked complete")
	}
	s.DefaultBranchCI.State = "ok"
	s.Alerts.Truncated = true
	if !githubPartial(s) {
		t.Fatal("truncated active alerts looked complete")
	}
}

func TestGitHubCapacityAndInvalidConfiguration(t *testing.T) {
	f := newFixture(t)
	f.call("POST", "/api/projects", map[string]any{"id": "capacity", "name": "Capacity", "modules": []string{"dependencies"}}, 201, nil)
	path := "/api/projects/capacity/github"
	for _, repo := range []string{"../secrets", "https://github.com/example/repo", "example/..", "example/repo?token=secret"} {
		f.call("PUT", path, map[string]any{"repository": repo, "token": githubFixtureToken, "enabled": true, "revision": 0}, 400, nil)
	}
	f.call("PUT", path, map[string]any{"repository": "example/repo", "token": "short", "enabled": true, "revision": 0}, 400, nil)
	tx, e := f.s.DB.Begin()
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback()
	for i := 0; i < 16; i++ {
		id := fmt.Sprintf("retained-%02d", i)
		if _, e = tx.Exec(`INSERT INTO projects(id,name,created,updated) VALUES(?,?,0,0)`, id, id); e != nil {
			t.Fatal(e)
		}
		if _, e = tx.Exec(`INSERT INTO github_sources(project_id,repository,token,enabled) VALUES(?,'example/repo','unused-fixture',0)`, id); e != nil {
			t.Fatal(e)
		}
	}
	if e = tx.Commit(); e != nil {
		t.Fatal(e)
	}
	f.call("PUT", path, map[string]any{"repository": "example/repo", "token": githubFixtureToken, "enabled": true, "revision": 0}, 409, nil)
	f.call("DELETE", "/api/projects/retained-00/github", map[string]int{"revision": 1}, 200, nil)
	f.call("PUT", path, map[string]any{"repository": "example/repo", "token": githubFixtureToken, "enabled": true, "revision": 0}, 200, nil)
}
