package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/Narehood/Phoenix/internal/canary"
	"github.com/Narehood/Phoenix/internal/core"
)

type cachedSource struct {
	ID                    string
	Config                canary.Config
	Token, Payload, Error string
	Collected             int64
}

func (s *Server) LoadCanary() error {
	if s.Config.CanaryFile == "" {
		return nil
	}
	b, e := os.ReadFile(s.Config.CanaryFile)
	if e != nil {
		return e
	}
	if len(b) > 32768 {
		return errors.New("Canary config too large")
	}
	var configs []canary.Config
	if e = json.Unmarshal(b, &configs); e != nil {
		return e
	}
	if len(configs) > 16 {
		return errors.New("too many Canary sources")
	}
	for _, c := range configs {
		if !validIdentifier(c.ID) || c.TokenFile == "" {
			return errors.New("invalid Canary source")
		}
		secret, e := os.ReadFile(c.TokenFile)
		if e != nil {
			return e
		}
		token := strings.TrimSpace(string(secret))
		if _, e = canary.New(c, token); e != nil {
			return e
		}
		c.TokenFile = ""
		var previous string
		_ = s.DB.QueryRow(`SELECT config FROM canary_sources WHERE id=?`, c.ID).Scan(&previous)
		if previous != "" && previous != core.Encode(c) {
			return errors.New("source ID config is immutable; assign a new source ID for a different origin or revision")
		}
		if previous == "" {
			var count int
			if e = s.DB.QueryRow(`SELECT COUNT(*) FROM canary_sources`).Scan(&count); e != nil {
				return e
			}
			if count >= 16 {
				return errors.New("Canary source capacity reached (16 retained source IDs)")
			}
		}
		if _, e = s.DB.Exec(`INSERT INTO canary_sources(id,config,token) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token`, c.ID, core.Encode(c), s.Vault.Seal(token, "canary:"+c.ID)); e != nil {
			return e
		}
	}
	return nil
}
func (s *Server) sources() ([]cachedSource, error) {
	rows, e := s.DB.Query(`SELECT id,config,token,payload,collected,error FROM canary_sources ORDER BY id LIMIT 16`)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []cachedSource{}
	for rows.Next() {
		var c cachedSource
		var config string
		if e = rows.Scan(&c.ID, &config, &c.Token, &c.Payload, &c.Collected, &c.Error); e != nil {
			return nil, e
		}
		if e = json.Unmarshal([]byte(config), &c.Config); e != nil {
			return nil, e
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
func (s *Server) pollSource(ctx context.Context, c cachedSource) error {
	token, e := s.Vault.Open(c.Token, "canary:"+c.ID)
	if e != nil {
		return e
	}
	client, e := canary.New(c.Config, token)
	if e != nil {
		return e
	}
	overview, e := client.Overview(ctx)
	if e != nil {
		_, _ = s.DB.Exec(`UPDATE canary_sources SET error=? WHERE id=?`, e.Error(), c.ID)
		return e
	}
	_, e = s.DB.Exec(`UPDATE canary_sources SET payload=?,collected=?,error='' WHERE id=?`, core.Encode(overview), s.Now().UnixMilli(), c.ID)
	return e
}
func (s *Server) pollCanary(ctx context.Context) {
	next := map[string]time.Time{}
	delay := map[string]time.Duration{}
	tick := time.NewTicker(5 * time.Second)
	defer tick.Stop()
	for {
		sources, e := s.sources()
		if e == nil {
			for _, c := range sources {
				if s.Now().Before(next[c.ID]) {
					continue
				}
				bounded, cancel := context.WithTimeout(ctx, 8*time.Second)
				e = s.pollSource(bounded, c)
				cancel()
				d := 30 * time.Second
				if e != nil {
					d = delay[c.ID] * 2
					if d < 30*time.Second {
						d = 30 * time.Second
					}
					if d > 10*time.Minute {
						d = 10 * time.Minute
					}
				}
				delay[c.ID] = d
				next[c.ID] = s.Now().Add(d)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

type mapping struct {
	HostID    string `json:"hostId"`
	SourceID  string `json:"sourceId"`
	MonitorID string `json:"monitorId"`
}

func (s *Server) mappingList() ([]mapping, error) {
	rows, e := s.DB.Query(`SELECT host_id,source_id,monitor_id FROM mappings LIMIT 2000`)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []mapping{}
	for rows.Next() {
		var m mapping
		if e = rows.Scan(&m.HostID, &m.SourceID, &m.MonitorID); e != nil {
			return nil, e
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
func (s *Server) canaryList(w http.ResponseWriter, r *http.Request, u core.User) error {
	sources, e := s.sources()
	if e != nil {
		return e
	}
	mappings, e := s.mappingList()
	if e != nil {
		return e
	}
	visible := []mapping{}
	for _, m := range mappings {
		ok, e := s.allowed(u.ID, m.HostID, "host.read")
		if e != nil {
			return e
		}
		if ok {
			visible = append(visible, m)
		}
	}
	out := []map[string]any{}
	for _, c := range sources {
		var overview canary.Overview
		if e = json.Unmarshal([]byte(c.Payload), &overview); e != nil {
			return e
		}
		freshness := "fresh"
		if c.Collected == 0 {
			freshness = "unknown"
		} else if c.Error != "" || s.Now().UnixMilli()-c.Collected > 90000 || overview.Now == 0 || s.Now().UnixMilli()-overview.Now > 90000 || overview.Now > s.Now().UnixMilli()+30000 {
			freshness = "stale"
		}
		monitors := []canary.MonitorView{}
		for _, v := range overview.Monitors {
			canSee := u.Role == "admin"
			for _, m := range visible {
				if m.SourceID == c.ID && m.MonitorID == v.Monitor.ID {
					canSee = true
				}
			}
			if canSee {
				monitors = append(monitors, v)
			}
		}
		if u.Role != "admin" && len(monitors) == 0 {
			continue
		}
		maintenance := []json.RawMessage{}
		for _, raw := range overview.Maintenance {
			var summary struct {
				Maintenance struct {
					ID string `json:"id"`
				} `json:"maintenance"`
			}
			if json.Unmarshal(raw, &summary) != nil {
				continue
			}
			include := u.Role == "admin"
			for _, monitor := range monitors {
				for _, id := range monitor.MaintenanceIDs {
					if id == summary.Maintenance.ID {
						include = true
					}
				}
			}
			if include {
				maintenance = append(maintenance, raw)
			}
		}
		out = append(out, map[string]any{"id": c.ID, "node": overview.Node, "revision": c.Config.ExpectedRevision, "collectedAt": c.Collected, "measuredAt": overview.Now, "freshness": freshness, "error": c.Error, "monitors": monitors, "maintenance": maintenance})
	}
	write(w, 200, map[string]any{"sources": out, "mappings": visible, "now": s.Now().UnixMilli()})
	return nil
}
func (s *Server) setMappings(w http.ResponseWriter, r *http.Request, u core.User) error {
	var b struct {
		Mappings []struct {
			SourceID  string `json:"sourceId"`
			MonitorID string `json:"monitorId"`
		} `json:"mappings"`
	}
	if e := decode(r, &b); e != nil {
		return e
	}
	if len(b.Mappings) > 20 {
		return fail(400, "too many mappings")
	}
	host := r.PathValue("host")
	tx, e := s.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if _, e = tx.Exec(`DELETE FROM mappings WHERE host_id=?`, host); e != nil {
		return e
	}
	for _, m := range b.Mappings {
		if !validIdentifier(m.SourceID) || !validIdentifier(m.MonitorID) {
			return fail(400, "invalid mapping")
		}
		var payload string
		if e = tx.QueryRow(`SELECT payload FROM canary_sources WHERE id=?`, m.SourceID).Scan(&payload); e != nil {
			return fail(400, "unknown source")
		}
		var o canary.Overview
		if e = json.Unmarshal([]byte(payload), &o); e != nil {
			return e
		}
		found := false
		for _, v := range o.Monitors {
			if v.Monitor.ID == m.MonitorID {
				found = true
			}
		}
		if !found {
			return fail(400, "monitor not in verified source inventory")
		}
		if _, e = tx.Exec(`INSERT INTO mappings VALUES(?,?,?)`, host, m.SourceID, m.MonitorID); e != nil {
			return e
		}
	}
	if e = s.audit(tx, u.ID, host, "canary.mapping", "", "completed"); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	write(w, 200, b)
	return nil
}
func (s *Server) canaryHistory(w http.ResponseWriter, r *http.Request, u core.User) error {
	source, monitor := r.PathValue("source"), r.PathValue("monitor")
	mappings, e := s.mappingList()
	if e != nil {
		return e
	}
	visible := false
	for _, m := range mappings {
		if m.SourceID == source && m.MonitorID == monitor {
			ok, e := s.allowed(u.ID, m.HostID, "host.read")
			if e != nil {
				return e
			}
			visible = visible || ok
		}
	}
	if !visible {
		return fail(403, "mapped host permission required")
	}
	if !s.rateKey("history:" + u.ID) {
		return fail(429, "history reads throttled")
	}
	sources, e := s.sources()
	if e != nil {
		return e
	}
	for _, c := range sources {
		if c.ID != source {
			continue
		}
		token, e := s.Vault.Open(c.Token, "canary:"+c.ID)
		if e != nil {
			return e
		}
		client, e := canary.New(c.Config, token)
		if e != nil {
			return e
		}
		if _, e = client.Overview(r.Context()); e != nil {
			return fail(503, "Canary source identity unavailable")
		}
		history, e := client.History(r.Context(), monitor)
		if e != nil {
			return fail(503, "Canary history unavailable")
		}
		write(w, 200, map[string]any{"sourceId": source, "monitorId": monitor, "observations": history, "collectedAt": s.Now().UnixMilli()})
		return nil
	}
	return fail(404, "source not found")
}
