package server

import (
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Narehood/Phoenix/internal/core"
	"github.com/Narehood/Phoenix/internal/store"
	"github.com/pquerna/otp/totp"
)

func TestProjectLifecycleCapabilitiesAndPersistence(t *testing.T) {
	f := newFixture(t)
	var inventory struct {
		Projects []core.Project `json:"projects"`
	}
	f.call("GET", "/api/projects", nil, 200, &inventory)
	if inventory.Projects == nil || len(inventory.Projects) != 0 {
		t.Fatal("new installation must have an empty project inventory")
	}
	var p core.Project
	create := map[string]any{"id": "example-project", "name": "Example project", "description": "Operator supplied metadata", "modules": []string{"dependencies", "documentation"}}
	f.call("POST", "/api/projects", create, 201, &p)
	if p.ID != "example-project" || p.Revision != 1 || p.CreatedAt != f.now.UnixMilli() || p.Archived {
		t.Fatal("invalid registered project", p)
	}
	f.call("POST", "/api/projects", create, 409, nil)
	var capabilities core.ProjectCapabilities
	f.call("GET", "/api/projects/"+p.ID+"/capabilities", nil, 200, &capabilities)
	if capabilities.ContractVersion != 1 || capabilities.ProjectID != p.ID || capabilities.Revision != 1 || len(capabilities.Modules) != 5 {
		t.Fatal("missing versioned capability metadata")
	}
	for _, c := range capabilities.Modules {
		if c.Actions == nil || len(c.Actions) != 0 {
			t.Fatal("foundation must not offer unimplemented connector actions")
		}
		if c.ID == "dependencies" {
			if c.State != "not_configured" || c.Reason != "github_not_configured" {
				t.Fatal("missing GitHub configuration was not explicit")
			}
			continue
		}
		if c.Enabled && (c.State != "unsupported" || c.Reason != "connector_not_implemented") || !c.Enabled && (c.State != "disabled" || c.Reason != "module_disabled") {
			t.Fatal("module selection was reported as implemented", c)
		}
	}
	f.advance(time.Second)
	update := map[string]any{"name": "Renamed project", "description": "Archived for now", "modules": []string{"dependencies"}, "archived": true, "revision": p.Revision}
	f.call("PUT", "/api/projects/"+p.ID, update, 200, &p)
	if p.Revision != 2 || !p.Archived || p.UpdatedAt != f.now.UnixMilli() || p.CreatedAt >= p.UpdatedAt {
		t.Fatal("project lifecycle metadata lost", p)
	}
	f.call("PUT", "/api/projects/"+p.ID, update, 409, nil)
	f.call("GET", "/api/projects/"+p.ID+"/capabilities", nil, 200, &capabilities)
	for _, c := range capabilities.Modules {
		if c.State != "disabled" || c.Reason != "project_archived" {
			t.Fatal("archive must disable all capabilities")
		}
	}
	var history struct {
		Events []struct {
			Action   string `json:"action"`
			Revision int64  `json:"revision"`
		} `json:"events"`
	}
	f.call("GET", "/api/projects/"+p.ID+"/audit", nil, 200, &history)
	if len(history.Events) != 2 || history.Events[0].Revision != 2 || history.Events[1].Action != "project.create" {
		t.Fatal("duplicate or rejected mutation changed audit history")
	}
	// Reopen only this test's newly generated database, never retained host state.
	if e := f.s.DB.Close(); e != nil {
		t.Fatal(e)
	}
	db, e := store.Open(filepath.Join(f.s.Config.DataDir, "phoenix.db"))
	if e != nil {
		t.Fatal(e)
	}
	f.s.DB = db
	f.s.Sessions.Store = &store.Sessions{DB: db}
	f.call("GET", "/api/projects/"+p.ID, nil, 200, &p)
	if p.Name != "Renamed project" || p.Revision != 2 || !p.Archived {
		t.Fatal("project state did not survive reopening")
	}
	update["revision"], update["archived"] = p.Revision, false
	f.call("PUT", "/api/projects/"+p.ID, update, 200, &p)
	if p.Archived || p.Revision != 3 {
		t.Fatal("project could not be restored from archive")
	}
}

func TestProjectAuthorizationAndRequestGuards(t *testing.T) {
	f := newFixture(t)
	for _, id := range []string{"visible", "private"} {
		f.call("POST", "/api/projects", map[string]any{"id": id, "name": id}, 201, nil)
	}
	var account struct {
		User   core.User `json:"user"`
		Secret string    `json:"secret"`
	}
	password := "project fixture password"
	f.call("POST", "/api/users", map[string]string{"name": "project-operator", "role": "operator", "password": password}, 201, &account)
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
	var inventory struct {
		Projects []core.Project `json:"projects"`
	}
	// Existing fleet-wide grants cannot expose this new category of data.
	f.replaceGrants(account.User.ID, []core.Grant{{ScopeType: "all", Scope: "*", Action: "*"}})
	f.request(operator, f.web.URL, "GET", "/api/projects", nil, 200, &inventory, "")
	if len(inventory.Projects) != 0 {
		t.Fatal("host wildcard leaked project metadata")
	}
	for _, path := range []string{"/api/projects/private", "/api/projects/private/capabilities", "/api/projects/private/audit", "/api/projects/absent"} {
		f.request(operator, f.web.URL, "GET", path, nil, 404, nil, "")
	}
	grants := []core.Grant{{ScopeType: "project", Scope: "visible", Action: "project.read"}}
	f.replaceGrants(account.User.ID, grants)
	f.request(operator, f.web.URL, "GET", "/api/projects", nil, 200, &inventory, "")
	if len(inventory.Projects) != 1 || inventory.Projects[0].ID != "visible" {
		t.Fatal("project inventory did not respect explicit grants")
	}
	body := map[string]any{"name": "Changed project", "modules": []string{"dependencies"}, "revision": 1}
	f.request(operator, f.web.URL, "PUT", "/api/projects/visible", body, 403, nil, auth.CSRF)
	f.request(operator, f.web.URL, "POST", "/api/projects", map[string]string{"id": "unauthorized", "name": "Unauthorized"}, 403, nil, auth.CSRF)
	grants = append(grants, core.Grant{ScopeType: "project", Scope: "visible", Action: "project.manage"})
	f.replaceGrants(account.User.ID, grants)
	f.request(operator, f.web.URL, "PUT", "/api/projects/visible", body, 403, nil, "")
	f.request(operator, f.web.URL, "PUT", "/api/projects/private", body, 404, nil, auth.CSRF)
	f.request(operator, f.web.URL, "PUT", "/api/projects/visible", body, 200, nil, auth.CSRF)
	// A project wildcard cannot authorize existing host actions.
	f.replaceGrants(account.User.ID, []core.Grant{{ScopeType: "project", Scope: "visible", Action: "*"}})
	h := f.newAgent("Separate host")
	f.request(operator, f.web.URL, "GET", "/api/hosts/"+h.id, nil, 403, nil, "")
	// Even a wildcard project grant cannot give a viewer write permission.
	if _, e = f.s.DB.Exec(`UPDATE users SET role='viewer' WHERE id=?`, account.User.ID); e != nil {
		t.Fatal(e)
	}
	body["revision"] = 2
	f.request(operator, f.web.URL, "PUT", "/api/projects/visible", body, 403, nil, auth.CSRF)
	f.request(operator, f.web.URL, "GET", "/api/projects/visible", nil, 200, nil, "")
	// Replacing grants takes effect on the existing session immediately.
	f.replaceGrants(account.User.ID, []core.Grant{})
	f.request(operator, f.web.URL, "GET", "/api/projects/visible", nil, 404, nil, "")
	f.request(&http.Client{Transport: f.browser.Transport, Timeout: 5 * time.Second}, f.web.URL, "GET", "/api/projects", nil, 401, nil, "")
	req, e := http.NewRequest("POST", f.web.URL+"/api/projects", strings.NewReader(`{"id":"bad-origin","name":"Bad origin"}`))
	if e != nil {
		t.Fatal(e)
	}
	req.Header.Set("Origin", "https://other.invalid")
	req.Header.Set("X-CSRF-Token", f.csrf)
	response, e := f.browser.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	response.Body.Close()
	if response.StatusCode != 403 {
		t.Fatal("project mutation accepted another origin")
	}
	f.advance(6 * time.Minute)
	f.call("PUT", "/api/projects/visible", body, 403, nil)
	f.call("POST", "/api/projects", map[string]string{"id": "stale-auth", "name": "Stale auth"}, 403, nil)
}

func TestProjectValidationCapacityAndAuditBounds(t *testing.T) {
	f := newFixture(t)
	for _, body := range []map[string]any{
		{"id": "../private", "name": "Invalid"},
		{"id": "UPPERCASE", "name": "Invalid"},
		{"id": "valid", "name": "Trailing space "},
		{"id": "valid", "name": "Valid", "description": strings.Repeat("x", 2049)},
		{"id": "valid", "name": "Valid", "description": "bad\x00metadata"},
		{"id": "valid", "name": "Valid", "modules": []string{"arbitrary-shell"}},
		{"id": "valid", "name": "Valid", "modules": []string{"content", "content"}},
		{"id": "valid", "name": "Valid", "token": "not-accepted"},
	} {
		f.call("POST", "/api/projects", body, 400, nil)
	}
	f.call("POST", "/api/projects", map[string]any{"id": "oversized", "name": "Oversized", "description": strings.Repeat("x", 9*1024)}, 400, nil)
	f.call("POST", "/api/projects", map[string]any{"id": "valid", "name": "Valid"}, 201, nil)
	f.call("PUT", "/api/projects/valid", map[string]any{"name": "Valid"}, 400, nil)
	// Failed grant validation must leave the old grant set intact.
	if _, e := f.s.DB.Exec(`INSERT INTO users(id,name,role,password,totp) VALUES('bounded-operator','Bounded operator','operator','fixture','fixture'); INSERT INTO grants VALUES('bounded-operator','project','valid','project.read')`); e != nil {
		t.Fatal(e)
	}
	for _, g := range []core.Grant{
		{ScopeType: "project", Scope: "missing", Action: "project.read"},
		{ScopeType: "project", Scope: "valid", Action: "host.reboot"},
		{ScopeType: "all", Scope: "*", Action: "project.manage"},
	} {
		f.call("PUT", "/api/users/bounded-operator/grants", map[string]any{"grants": []core.Grant{g}, "expectedGrants": []core.Grant{{ScopeType: "project", Scope: "valid", Action: "project.read"}}}, 400, nil)
	}
	if ok, e := projectAllowed(f.s.DB, "bounded-operator", "valid", "project.read"); e != nil || !ok {
		t.Fatal("failed grant replacement removed existing access", e)
	}
	// Exercise successful API writes beyond retention, including stale-save safety.
	for revision := 1; revision <= 105; revision++ {
		f.call("PUT", "/api/projects/valid", map[string]any{"name": "Valid", "revision": revision}, 200, nil)
	}
	var count, oldest, newest int
	if e := f.s.DB.QueryRow(`SELECT COUNT(*),MIN(revision),MAX(revision) FROM project_audit WHERE project_id='valid'`).Scan(&count, &oldest, &newest); e != nil || count != 100 || oldest != 7 || newest != 106 {
		t.Fatal("audit retention is not bounded to the newest 100 revisions", count, oldest, newest, e)
	}
	// Fill only this temporary fixture; archived records still consume capacity.
	tx, e := f.s.DB.Begin()
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback()
	for i := 1; i < projectLimit; i++ {
		if _, e = tx.Exec(`INSERT INTO projects(id,name,archived,created,updated) VALUES(?,?,1,0,0)`, fmt.Sprintf("fixture-%03d", i), "Archived fixture"); e != nil {
			t.Fatal(e)
		}
	}
	if e = tx.Commit(); e != nil {
		t.Fatal(e)
	}
	f.call("POST", "/api/projects", map[string]any{"id": "over-capacity", "name": "Over capacity"}, 409, nil)
	if e = f.s.DB.QueryRow(`SELECT COUNT(*) FROM projects`).Scan(&count); e != nil || count != projectLimit {
		t.Fatal("capacity failure changed inventory", e)
	}
}
