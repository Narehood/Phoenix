package server

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/Narehood/Phoenix/internal/core"
)

const projectLimit = 100
const projectColumns = `id,name,description,modules,archived,revision,created,updated`

var validProjectID = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
var projectActions = map[string]bool{"project.read": true, "project.manage": true, "github.read": true, "github.sync": true}
var maintenanceModules = []string{"documentation", "dependencies", "content", "releases", "operations"}

func scanProject(row interface{ Scan(...any) error }) (core.Project, error) {
	var p core.Project
	var modules string
	if e := row.Scan(&p.ID, &p.Name, &p.Description, &modules, &p.Archived, &p.Revision, &p.CreatedAt, &p.UpdatedAt); e != nil {
		return p, e
	}
	e := json.Unmarshal([]byte(modules), &p.Modules)
	return p, e
}

// Project scopes are separate from host/group/all scopes. In particular, old
// fleet-wide wildcard grants must not grant access to this new data category.
func projectAllowed(q querier, user, project, action string) (bool, error) {
	if !projectActions[action] {
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
	if role == "admin" {
		return true, nil
	}
	if role != "operator" && role != "viewer" || role == "viewer" && action != "project.read" && action != "github.read" {
		return false, nil
	}
	var n int
	e := q.QueryRow(`SELECT COUNT(*) FROM grants WHERE user_id=? AND scope_type='project' AND scope=? AND (action=? OR action='*')`, user, project, action).Scan(&n)
	return n > 0, e
}

func projectInputOK(name, description string, modules []string) bool {
	if !validName.MatchString(name) || strings.TrimSpace(name) != name || len(description) > 2048 || !utf8.ValidString(description) || len(modules) > len(maintenanceModules) {
		return false
	}
	for _, c := range description {
		if unicode.IsControl(c) && c != '\n' && c != '\t' {
			return false
		}
	}
	seen := map[string]bool{}
	for _, module := range modules {
		known := false
		for _, allowed := range maintenanceModules {
			known = known || module == allowed
		}
		if !known || seen[module] {
			return false
		}
		seen[module] = true
	}
	return true
}

func (s *Server) listProjects(w http.ResponseWriter, r *http.Request, u core.User) error {
	rows, e := s.DB.Query(`SELECT ` + projectColumns + ` FROM projects ORDER BY id LIMIT 100`)
	if e != nil {
		return e
	}
	// Close the cursor before permission queries on the single-connection DB.
	all := []core.Project{}
	for rows.Next() {
		p, err := scanProject(rows)
		if err != nil {
			rows.Close()
			return err
		}
		all = append(all, p)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	out := []core.Project{}
	for _, p := range all {
		ok, err := projectAllowed(s.DB, u.ID, p.ID, "project.read")
		if err != nil {
			return err
		}
		if ok {
			out = append(out, p)
		}
	}
	write(w, 200, map[string]any{"projects": out})
	return nil
}

func readProject(q querier, user, id string) (core.Project, error) {
	// Identical response for absent and inaccessible IDs, including capabilities.
	ok, e := projectAllowed(q, user, id, "project.read")
	if e != nil {
		return core.Project{}, e
	}
	if !ok {
		return core.Project{}, fail(404, "project not found")
	}
	p, e := scanProject(q.QueryRow(`SELECT `+projectColumns+` FROM projects WHERE id=?`, id))
	if e == sql.ErrNoRows {
		return p, fail(404, "project not found")
	}
	return p, e
}

func (s *Server) projectDetail(w http.ResponseWriter, r *http.Request, u core.User) error {
	p, e := readProject(s.DB, u.ID, r.PathValue("project"))
	if e != nil {
		return e
	}
	write(w, 200, p)
	return nil
}

func (s *Server) createProject(w http.ResponseWriter, r *http.Request, u core.User) error {
	var b struct {
		ID          string   `json:"id"`
		Name        string   `json:"name"`
		Description string   `json:"description"`
		Modules     []string `json:"modules"`
	}
	if e := decodeLimit(r, &b, 8*1024); e != nil {
		return e
	}
	if !validProjectID.MatchString(b.ID) || !projectInputOK(b.Name, b.Description, b.Modules) {
		return fail(400, "invalid project metadata or modules")
	}
	if b.Modules == nil {
		b.Modules = []string{}
	}
	tx, e := s.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var n int
	if e = tx.QueryRow(`SELECT COUNT(*) FROM projects`).Scan(&n); e != nil {
		return e
	}
	if n >= projectLimit {
		return fail(409, "project capacity reached (including archived projects)")
	}
	if e = tx.QueryRow(`SELECT COUNT(*) FROM projects WHERE id=?`, b.ID).Scan(&n); e != nil {
		return e
	}
	if n != 0 {
		return fail(409, "project ID already registered")
	}
	now := s.Now().UnixMilli()
	p := core.Project{ID: b.ID, Name: b.Name, Description: b.Description, Modules: b.Modules, Revision: 1, CreatedAt: now, UpdatedAt: now}
	if _, e = tx.Exec(`INSERT INTO projects(id,name,description,modules,archived,revision,created,updated) VALUES(?,?,?,?,0,1,?,?)`, p.ID, p.Name, p.Description, core.Encode(p.Modules), now, now); e != nil {
		return e
	}
	if e = s.auditProject(tx, u.ID, p.ID, "project.create"); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	write(w, 201, p)
	return nil
}

func (s *Server) updateProject(w http.ResponseWriter, r *http.Request, u core.User) error {
	var b struct {
		Name        string   `json:"name"`
		Description string   `json:"description"`
		Modules     []string `json:"modules"`
		Archived    bool     `json:"archived"`
		Revision    int64    `json:"revision"`
	}
	if e := decodeLimit(r, &b, 8*1024); e != nil {
		return e
	}
	if b.Revision < 1 || !projectInputOK(b.Name, b.Description, b.Modules) {
		return fail(400, "invalid project metadata, modules or revision")
	}
	if b.Modules == nil {
		b.Modules = []string{}
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
	ok, e := projectAllowed(tx, u.ID, p.ID, "project.manage")
	if e != nil {
		return e
	}
	if !ok {
		return fail(403, "project management forbidden")
	}
	if p.Revision != b.Revision {
		return fail(409, "project changed; reload before saving")
	}
	p.Name, p.Description, p.Modules, p.Archived = b.Name, b.Description, b.Modules, b.Archived
	p.Revision++
	p.UpdatedAt = s.Now().UnixMilli()
	if _, e = tx.Exec(`UPDATE projects SET name=?,description=?,modules=?,archived=?,revision=?,updated=? WHERE id=?`, p.Name, p.Description, core.Encode(p.Modules), p.Archived, p.Revision, p.UpdatedAt, p.ID); e != nil {
		return e
	}
	if e = s.auditProject(tx, u.ID, p.ID, "project.update"); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	write(w, 200, p)
	return nil
}

func (s *Server) auditProject(tx *sql.Tx, actor, project, action string) error {
	_, e := tx.Exec(`INSERT INTO project_audit(at,actor,project_id,action,revision) SELECT ?,?,?,?,revision FROM projects WHERE id=?`, s.Now().UnixMilli(), actor, project, action, project)
	return e
}

func (s *Server) projectAudit(w http.ResponseWriter, r *http.Request, u core.User) error {
	p, e := readProject(s.DB, u.ID, r.PathValue("project"))
	if e != nil {
		return e
	}
	rows, e := s.DB.Query(`SELECT at,actor,action,revision FROM project_audit WHERE project_id=? ORDER BY id DESC LIMIT 100`, p.ID)
	if e != nil {
		return e
	}
	defer rows.Close()
	type event struct {
		At       int64  `json:"at"`
		Actor    string `json:"actor"`
		Action   string `json:"action"`
		Revision int64  `json:"revision"`
	}
	out := []event{}
	for rows.Next() {
		var v event
		if e = rows.Scan(&v.At, &v.Actor, &v.Action, &v.Revision); e != nil {
			return e
		}
		out = append(out, v)
	}
	if e = rows.Err(); e != nil {
		return e
	}
	write(w, 200, map[string]any{"events": out})
	return nil
}

func (s *Server) projectCapabilities(w http.ResponseWriter, r *http.Request, u core.User) error {
	p, e := readProject(s.DB, u.ID, r.PathValue("project"))
	if e != nil {
		return e
	}
	out := core.ProjectCapabilities{ContractVersion: core.MaintenanceContract, ProjectID: p.ID, Revision: p.Revision, Modules: []core.ProjectCapability{}}
	for _, action := range []string{"project.read", "project.manage", "github.read", "github.sync"} {
		ok, err := projectAllowed(s.DB, u.ID, p.ID, action)
		if err != nil {
			return err
		}
		if ok {
			out.Permissions = append(out.Permissions, action)
		}
	}
	for _, module := range maintenanceModules {
		enabled := false
		for _, selected := range p.Modules {
			enabled = enabled || selected == module
		}
		c := core.ProjectCapability{ID: module, Enabled: enabled, State: "disabled", Reason: "module_disabled", Actions: []string{}}
		if enabled {
			c.State, c.Reason = "unsupported", "connector_not_implemented"
		}
		if enabled && module == "dependencies" {
			c.State, c.Reason = "not_configured", "github_not_configured"
			ok, err := projectAllowed(s.DB, u.ID, p.ID, "github.read")
			if err != nil {
				return err
			}
			if !ok {
				c.State, c.Reason = "permission_denied", "github_read_required"
			} else {
				g, err := scanGitHub(s.DB.QueryRow(`SELECT `+githubColumns+` FROM github_sources WHERE project_id=?`, p.ID))
				if err != nil && err != sql.ErrNoRows {
					return err
				}
				v, err := s.githubView(p, g)
				if err != nil {
					return err
				}
				c.State = v.State
				c.Reason = "github_read_only"
				if !v.Configured {
					c.Reason = "github_not_configured"
				}
			}
		}
		if p.Archived {
			c.State, c.Reason = "disabled", "project_archived"
		}
		out.Modules = append(out.Modules, c)
	}
	write(w, 200, out)
	return nil
}
