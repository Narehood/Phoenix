package server

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"time"

	"github.com/Narehood/Phoenix/internal/core"
	"github.com/Narehood/Phoenix/internal/security"
)

const jobColumns = `id,actor,host_id,action,args,state,created,expires,deadline,timeout,dispatched,finished,cancel,boot_before,reboot_observed,result`

func scanJob(row interface{ Scan(...any) error }) (core.Job, error) {
	var j core.Job
	var args string
	var result sql.NullString
	e := row.Scan(&j.ID, &j.Actor, &j.HostID, &j.Action, &args, &j.State, &j.CreatedAt, &j.ExpiresAt, &j.Deadline, &j.TimeoutSeconds, &j.DispatchedAt, &j.FinishedAt, &j.CancelRequested, &j.BootBefore, &j.RebootObserved, &result)
	if e != nil {
		return j, e
	}
	if e = json.Unmarshal([]byte(args), &j.Args); e != nil {
		return j, e
	}
	if result.Valid {
		j.Result = &core.Result{}
		e = json.Unmarshal([]byte(result.String), j.Result)
	}
	return j, e
}
func validateAction(action string, args core.Args) bool {
	switch action {
	case "diagnostic":
		return args.Diagnostic == "system.summary" && args.Service == ""
	case "service.restart", "logs.read":
		return validService.MatchString(args.Service) && args.Diagnostic == ""
	case "host.reboot", "services.inspect":
		return args.Service == "" && args.Diagnostic == ""
	}
	return false
}
func (s *Server) createJob(w http.ResponseWriter, r *http.Request, u core.User) error {
	var b struct {
		Action         string    `json:"action"`
		Args           core.Args `json:"args"`
		Confirm        string    `json:"confirm"`
		TimeoutSeconds int       `json:"timeoutSeconds"`
		ExpiresSeconds int       `json:"expiresSeconds"`
	}
	if e := decode(r, &b); e != nil {
		return e
	}
	if !validateAction(b.Action, b.Args) {
		return fail(400, "invalid typed action or arguments")
	}
	host := r.PathValue("host")
	if b.TimeoutSeconds == 0 {
		b.TimeoutSeconds = 30
	}
	if b.ExpiresSeconds == 0 {
		b.ExpiresSeconds = 300
	}
	if b.TimeoutSeconds < 1 || b.TimeoutSeconds > 30 || b.ExpiresSeconds < 1 || b.ExpiresSeconds > 300 {
		return fail(400, "job limits exceeded")
	}
	if b.Action == "host.reboot" || b.Action == "service.restart" {
		if b.Confirm != host {
			return fail(400, "destructive action requires exact host ID confirmation")
		}
		if s.Now().Unix()-s.Sessions.GetInt64(r.Context(), "recent") > 300 {
			return fail(403, "recent password and MFA required")
		}
	}
	tx, e := s.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	for _, action := range []string{"host.read", b.Action} {
		ok, e := allowedDB(tx, u.ID, host, action)
		if e != nil {
			return e
		}
		if !ok {
			return fail(403, "action forbidden")
		}
	}
	var revoked, verified bool
	var boot string
	if e = tx.QueryRow(`SELECT revoked,verified,boot_id FROM hosts WHERE id=?`, host).Scan(&revoked, &verified, &boot); e != nil {
		return fail(404, "host not found")
	}
	if revoked {
		return fail(409, "agent revoked or not enrolled")
	}
	if !verified {
		return fail(409, "administrator must verify the enrolled identity before management")
	}
	var count int
	if e = tx.QueryRow(`SELECT COUNT(*) FROM jobs WHERE host_id=? AND state='queued'`, host).Scan(&count); e != nil {
		return e
	}
	if count >= 128 {
		return fail(409, "host queue full")
	}
	if e = tx.QueryRow(`SELECT COUNT(*) FROM jobs`).Scan(&count); e != nil {
		return e
	}
	if count >= 50000 {
		return fail(409, "job retention capacity reached")
	}
	j := core.Job{ID: security.Token(), Actor: u.ID, HostID: host, Action: b.Action, Args: b.Args, State: "queued", CreatedAt: s.Now().UnixMilli(), ExpiresAt: s.Now().Add(time.Duration(b.ExpiresSeconds) * time.Second).UnixMilli(), TimeoutSeconds: b.TimeoutSeconds, BootBefore: boot}
	_, e = tx.Exec(`INSERT INTO jobs(id,actor,host_id,action,args,state,created,expires,deadline,timeout,boot_before) VALUES(?,?,?,?,?,?,?,?,0,?,?)`, j.ID, j.Actor, host, j.Action, core.Encode(j.Args), j.State, j.CreatedAt, j.ExpiresAt, j.TimeoutSeconds, j.BootBefore)
	if e != nil {
		return e
	}
	if e = s.audit(tx, u.ID, host, j.Action, j.ID, "queued"); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	write(w, 201, j)
	return nil
}
func (s *Server) listJobs(w http.ResponseWriter, r *http.Request, u core.User) error {
	rows, e := s.DB.Query(`SELECT ` + jobColumns + ` FROM jobs ORDER BY created DESC LIMIT 200`)
	if e != nil {
		return e
	}
	all := []core.Job{}
	for rows.Next() {
		j, e := scanJob(rows)
		if e != nil {
			rows.Close()
			return e
		}
		j.Result = nil
		all = append(all, j)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	out := []core.Job{}
	for _, j := range all {
		ok, e := s.allowed(u.ID, j.HostID, "host.read")
		if e != nil {
			return e
		}
		if ok {
			out = append(out, j)
		}
	}
	write(w, 200, out)
	return nil
}
func (s *Server) getJob(w http.ResponseWriter, r *http.Request, u core.User) error {
	j, e := scanJob(s.DB.QueryRow(`SELECT `+jobColumns+` FROM jobs WHERE id=?`, r.PathValue("job")))
	if e != nil {
		return fail(404, "job not found")
	}
	ok, e := s.allowed(u.ID, j.HostID, "host.read")
	if e != nil {
		return e
	}
	if !ok {
		return fail(403, "action forbidden")
	}
	ok, e = s.allowed(u.ID, j.HostID, "jobs.output")
	if e != nil {
		return e
	}
	if !ok {
		j.Result = nil
	}
	write(w, 200, j)
	return nil
}
func (s *Server) cancelJob(w http.ResponseWriter, r *http.Request, u core.User) error {
	tx, e := s.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	j, e := scanJob(tx.QueryRow(`SELECT `+jobColumns+` FROM jobs WHERE id=?`, r.PathValue("job")))
	if e != nil {
		return fail(404, "job not found")
	}
	ok, e := allowedDB(tx, u.ID, j.HostID, "jobs.cancel")
	if e != nil {
		return e
	}
	if !ok {
		return fail(403, "action forbidden")
	}
	if j.State != "queued" && j.State != "dispatched" {
		return fail(409, "job is no longer cancellable")
	}
	state := j.State
	finish := int64(0)
	if state == "queued" {
		state = "cancelled"
		finish = s.Now().UnixMilli()
	}
	if _, e = tx.Exec(`UPDATE jobs SET cancel=1,state=?,finished=? WHERE id=?`, state, finish, j.ID); e != nil {
		return e
	}
	if e = s.audit(tx, u.ID, j.HostID, j.Action, j.ID, "cancellation_requested"); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	write(w, 200, map[string]bool{"requested": true})
	return nil
}
