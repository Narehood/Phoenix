package agent

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/Narehood/Phoenix/internal/core"
)

type Policy struct {
	RestartServices []string `json:"restartServices"`
	LogServices     []string `json:"logServices"`
	AllowReboot     bool     `json:"allowReboot"`
}

func (p Policy) Allows(j core.Job) bool {
	switch j.Action {
	case "diagnostic":
		return j.Args.Diagnostic == "system.summary" && j.Args.Service == ""
	case "services.inspect":
		return j.Args.Service == "" && j.Args.Diagnostic == ""
	case "service.restart":
		return j.Args.Diagnostic == "" && contains(p.RestartServices, j.Args.Service)
	case "logs.read":
		return j.Args.Diagnostic == "" && contains(p.LogServices, j.Args.Service)
	case "host.reboot":
		return p.AllowReboot && j.Args.Service == "" && j.Args.Diagnostic == ""
	}
	return false
}
func contains(xs []string, s string) bool {
	for _, v := range xs {
		if v == s {
			return true
		}
	}
	return false
}

type Engine struct {
	DB       *sql.DB
	Platform core.Platform
	Policy   Policy
	Now      core.Clock
	mu       sync.Mutex
}

func (e *Engine) Recover() error {
	now := e.Now().UnixMilli()
	r := core.Result{State: "uncertain", ExitCode: -1, FinishedAt: now, Stderr: "Agent restarted after claiming this job; it will not be executed again."}
	_, err := e.DB.Exec(`UPDATE agent_jobs SET state='done',result=? WHERE state='claimed'`, core.Encode(r))
	return err
}
func (e *Engine) Run(ctx context.Context, j core.Job) core.Result {
	now := e.Now().UnixMilli()
	rejected := func(state, msg string) core.Result {
		return core.Result{State: state, Stderr: msg, ExitCode: -1, StartedAt: now, FinishedAt: now}
	}
	if !e.mu.TryLock() {
		return rejected("uncertain", "Agent execution slot busy")
	}
	defer e.mu.Unlock()
	tx, err := e.DB.Begin()
	if err != nil {
		return rejected("uncertain", "Job ledger unavailable")
	}
	var result sql.NullString
	var state string
	err = tx.QueryRow(`SELECT state,result FROM agent_jobs WHERE id=?`, j.ID).Scan(&state, &result)
	if err == nil {
		_ = tx.Rollback()
		if result.Valid {
			var r core.Result
			if json.Unmarshal([]byte(result.String), &r) != nil {
				return rejected("uncertain", "Stored receipt unavailable")
			}
			return r
		}
		return rejected("uncertain", "Job already claimed; refusing duplicate execution")
	}
	if !errors.Is(err, sql.ErrNoRows) {
		_ = tx.Rollback()
		return rejected("uncertain", "Job ledger unavailable")
	}
	var count int
	if err = tx.QueryRow(`SELECT COUNT(*) FROM agent_jobs`).Scan(&count); err != nil || count >= 10000 {
		_ = tx.Rollback()
		return rejected("failed", "Job ledger capacity reached")
	}
	if _, err = tx.Exec(`INSERT INTO agent_jobs(id,state,created) VALUES(?,'claimed',?)`, j.ID, now); err != nil {
		_ = tx.Rollback()
		return rejected("uncertain", "Job claim failed")
	}
	if err = tx.Commit(); err != nil {
		return rejected("uncertain", "Job claim uncertain")
	}
	var r core.Result
	if j.ExpiresAt <= now || j.Deadline <= now {
		r = rejected("failed", "Job expired; not executed")
	} else if !e.Policy.Allows(j) {
		r = rejected("failed", "Local policy refused action")
	} else {
		deadline := time.UnixMilli(j.Deadline)
		if max := e.Now().Add(30 * time.Second); deadline.After(max) {
			deadline = max
		}
		bounded, cancel := context.WithDeadline(ctx, deadline)
		r = e.Platform.Execute(bounded, j)
		cancel()
		r.Stdout = strings.ToValidUTF8(r.Stdout, "\uFFFD")
		r.Stderr = strings.ToValidUTF8(r.Stderr, "\uFFFD")
		if len(r.Stdout)+len(r.Stderr) > core.OutputLimit {
			r.Stdout = truncate(r.Stdout, core.OutputLimit)
			r.Stderr = truncate(r.Stderr, core.OutputLimit-len(r.Stdout))
			r.Truncated = true
		}
		if r.StartedAt == 0 {
			r.StartedAt = now
		}
		if r.FinishedAt == 0 {
			r.FinishedAt = e.Now().UnixMilli()
		}
	}
	if _, err = e.DB.Exec(`UPDATE agent_jobs SET state='done',result=? WHERE id=?`, core.Encode(r), j.ID); err != nil {
		return rejected("uncertain", "Execution finished but receipt persistence failed")
	}
	return r
}
func truncate(s string, n int) string {
	s = strings.ToValidUTF8(s, "\uFFFD")
	if len(s) > n {
		s = s[:n]
		for !utf8.ValidString(s) {
			s = s[:len(s)-1]
		}
	}
	return s
}
func (e *Engine) Pending() ([]core.Receipt, error) {
	rows, err := e.DB.Query(`SELECT id,result FROM agent_jobs WHERE state='done' ORDER BY created LIMIT 1`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []core.Receipt{}
	for rows.Next() {
		var id, b string
		if err = rows.Scan(&id, &b); err != nil {
			return nil, err
		}
		var r core.Result
		if err = json.Unmarshal([]byte(b), &r); err != nil {
			return nil, err
		}
		out = append(out, core.Receipt{ID: id, Result: r})
	}
	return out, rows.Err()
}
func (e *Engine) Acknowledge(ids []string) error {
	for _, id := range ids {
		if _, err := e.DB.Exec(`UPDATE agent_jobs SET state='acknowledged' WHERE id=? AND state='done'`, id); err != nil {
			return err
		}
	}
	_, err := e.DB.Exec(`UPDATE agent_jobs SET result=NULL WHERE state='acknowledged' AND id NOT IN(SELECT id FROM agent_jobs WHERE result IS NOT NULL ORDER BY created DESC LIMIT 200)`)
	return err
}

// Ledger IDs are retained. At 10,000 entries the agent fails closed until an
// operator archives/re-enrolls it; deleting IDs would weaken crash deduplication.
