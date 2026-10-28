package server

import (
	"database/sql"
	"encoding/json"
	"encoding/pem"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/Narehood/Phoenix/internal/core"
	"github.com/Narehood/Phoenix/internal/security"
)

const hostColumns = `id,name,os,os_version,addresses,tags,groups_json,agent_version,last_contact,revoked,verified,fingerprint,generation,boot_id`

func scanHost(row interface{ Scan(...any) error }) (core.Host, error) {
	var h core.Host
	var addresses, tags, groups string
	e := row.Scan(&h.ID, &h.Name, &h.OS, &h.OSVersion, &addresses, &tags, &groups, &h.AgentVersion, &h.LastContact, &h.Revoked, &h.Verified, &h.CertificateFingerprint, &h.Generation, &h.BootID)
	if e != nil {
		return h, e
	}
	if e = json.Unmarshal([]byte(addresses), &h.Addresses); e != nil {
		return h, e
	}
	if e = json.Unmarshal([]byte(tags), &h.Tags); e != nil {
		return h, e
	}
	e = json.Unmarshal([]byte(groups), &h.Groups)
	h.ConnectionMethod = "outbound-agent"
	return h, e
}
func (s *Server) host(id string) (core.Host, error) {
	h, e := scanHost(s.DB.QueryRow(`SELECT `+hostColumns+` FROM hosts WHERE id=?`, id))
	if e == sql.ErrNoRows {
		return h, fail(404, "host not found")
	}
	if e != nil {
		return h, e
	}
	var payload string
	var measured, collected int64
	e = s.DB.QueryRow(`SELECT payload,measured,collected FROM samples WHERE host_id=? ORDER BY id DESC LIMIT 1`, id).Scan(&payload, &measured, &collected)
	h.Freshness = "unknown"
	h.ResourceHealth = "unknown"
	if e == nil {
		var reading core.Reading
		if e = json.Unmarshal([]byte(payload), &reading); e != nil {
			return h, e
		}
		h.Latest = &core.Sample{Reading: reading, CollectedAt: collected}
		h.Freshness = "fresh"
		if s.Now().UnixMilli()-measured > 90000 || s.Now().UnixMilli()-collected > 90000 {
			h.Freshness = "stale"
		}
		if h.Freshness == "fresh" && len(reading.CollectionErrors) == 0 && reading.CPUPercent != nil && reading.MemoryTotal > 0 && reading.DiskTotal > 0 {
			h.ResourceHealth = "normal"
			if *reading.CPUPercent > 90 || float64(reading.MemoryUsed)/float64(reading.MemoryTotal) > 0.9 || float64(reading.DiskUsed)/float64(reading.DiskTotal) > 0.9 {
				h.ResourceHealth = "warning"
			}
		}
	} else if e != sql.ErrNoRows {
		return h, e
	}
	h.Connectivity = "offline"
	if h.LastContact > 0 && s.Now().UnixMilli()-h.LastContact < 45000 {
		h.Connectivity = "connected"
	}
	if h.LastContact == 0 {
		h.Connectivity = "never_seen"
	}
	if h.Revoked {
		h.Connectivity = "revoked"
	}
	return h, nil
}
func (s *Server) visibleHosts(u core.User) ([]core.Host, error) {
	rows, e := s.DB.Query(`SELECT id FROM hosts ORDER BY name LIMIT 500`)
	if e != nil {
		return nil, e
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if e = rows.Scan(&id); e != nil {
			rows.Close()
			return nil, e
		}
		ids = append(ids, id)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	out := []core.Host{}
	for _, id := range ids {
		ok, e := s.allowed(u.ID, id, "host.read")
		if e != nil {
			return nil, e
		}
		if !ok {
			continue
		}
		h, e := s.host(id)
		if e != nil {
			return nil, e
		}
		out = append(out, h)
	}
	return out, nil
}
func (s *Server) listHosts(w http.ResponseWriter, r *http.Request, u core.User) error {
	out, e := s.visibleHosts(u)
	if e != nil {
		return e
	}
	write(w, 200, map[string]any{"hosts": out, "now": s.Now().UnixMilli()})
	return nil
}
func (s *Server) hostDetail(w http.ResponseWriter, r *http.Request, u core.User) error {
	h, e := s.host(r.PathValue("host"))
	if e != nil {
		return e
	}
	rows, e := s.DB.Query(`SELECT payload,collected FROM samples WHERE host_id=? ORDER BY id DESC LIMIT ?`, h.ID, core.SampleLimit)
	if e != nil {
		return e
	}
	samples := []core.Sample{}
	for rows.Next() {
		var p string
		var c int64
		if e = rows.Scan(&p, &c); e != nil {
			rows.Close()
			return e
		}
		var reading core.Reading
		if e = json.Unmarshal([]byte(p), &reading); e != nil {
			rows.Close()
			return e
		}
		samples = append(samples, core.Sample{Reading: reading, CollectedAt: c})
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	write(w, 200, map[string]any{"host": h, "samples": samples, "now": s.Now().UnixMilli()})
	return nil
}
func (s *Server) updateHost(w http.ResponseWriter, r *http.Request, u core.User) error {
	var b struct {
		Name   string   `json:"name"`
		Tags   []string `json:"tags"`
		Groups []string `json:"groups"`
	}
	if e := decode(r, &b); e != nil {
		return e
	}
	if !validName.MatchString(b.Name) || !cleanStrings(b.Tags) || !cleanStrings(b.Groups) {
		return fail(400, "invalid inventory metadata")
	}
	if u.Role != "admin" {
		return fail(403, "inventory and permission scopes require administrator")
	}
	tx, e := s.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	res, e := tx.Exec(`UPDATE hosts SET name=?,tags=?,groups_json=? WHERE id=?`, b.Name, core.Encode(b.Tags), core.Encode(b.Groups), r.PathValue("host"))
	if e != nil {
		return e
	}
	n, _ := res.RowsAffected()
	if n != 1 {
		return fail(404, "host not found")
	}
	if e = s.audit(tx, u.ID, r.PathValue("host"), "inventory.update", "", "completed"); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	h, e := s.host(r.PathValue("host"))
	if e != nil {
		return e
	}
	write(w, 200, h)
	return nil
}
func (s *Server) invite(w http.ResponseWriter, r *http.Request, u core.User) error {
	var b struct {
		Name         string   `json:"name"`
		Groups       []string `json:"groups"`
		ReenrollHost string   `json:"reenrollHost"`
		Confirm      string   `json:"confirm"`
	}
	if e := decode(r, &b); e != nil {
		return e
	}
	if !validName.MatchString(b.Name) || !cleanStrings(b.Groups) {
		return fail(400, "invalid host metadata")
	}
	host := b.ReenrollHost
	if host == "" {
		host = security.Token()
	}
	token := security.Token()
	expiry := s.Now().Add(10 * time.Minute).UnixMilli()
	tx, e := s.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if b.ReenrollHost != "" {
		var revoked bool
		if e = tx.QueryRow(`SELECT revoked FROM hosts WHERE id=?`, host).Scan(&revoked); e != nil || !revoked || b.Confirm != host {
			return fail(409, "re-enrollment requires revoked host and explicit host ID confirmation")
		}
		if _, e = tx.Exec(`UPDATE invitations SET used=1 WHERE host_id=?`, host); e != nil {
			return e
		}
	} else {
		var n int
		if e = tx.QueryRow(`SELECT COUNT(*) FROM hosts`).Scan(&n); e != nil {
			return e
		}
		if n >= 500 {
			return fail(409, "host capacity reached")
		}
		if _, e = tx.Exec(`INSERT INTO hosts(id,name,groups_json) VALUES(?,?,?)`, host, b.Name, core.Encode(b.Groups)); e != nil {
			return e
		}
	}
	_, e = tx.Exec(`INSERT INTO invitations(hash,host_id,expires) VALUES(?,?,?)`, security.Hash(token), host, expiry)
	if e != nil {
		return e
	}
	if e = s.audit(tx, u.ID, host, "invitation.create", "", "issued"); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	write(w, 201, map[string]any{"hostId": host, "invitation": token, "expiresAt": expiry})
	return nil
}
func (s *Server) enroll(w http.ResponseWriter, r *http.Request) error {
	if !s.rate(r) {
		return fail(429, "enrollment throttled")
	}
	var b core.Enrollment
	if e := decode(r, &b); e != nil {
		return e
	}
	if b.OS != "linux" || len(b.OSVersion) > 120 || len(b.AgentVersion) > 40 || len(b.Addresses) > 16 {
		return fail(400, "unsupported platform or invalid agent metadata")
	}
	for _, a := range b.Addresses {
		if net.ParseIP(a) == nil {
			return fail(400, "invalid address")
		}
	}
	tx, e := s.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var host string
	var used, revoked bool
	var expires int64
	e = tx.QueryRow(`SELECT i.host_id,i.expires,i.used,h.revoked FROM invitations i JOIN hosts h ON h.id=i.host_id WHERE i.hash=?`, security.Hash(b.Invitation)).Scan(&host, &expires, &used, &revoked)
	if e != nil || used || !revoked || expires <= s.Now().UnixMilli() {
		return fail(403, "invalid enrollment invitation")
	}
	cert, serial, expiry, e := s.CA.Sign(b.CSR, host, 24*time.Hour)
	if e != nil {
		return fail(400, "invalid agent CSR")
	}
	block, _ := pem.Decode([]byte(cert))
	if block == nil {
		return fail(503, "certificate encoding unavailable")
	}
	_, e = tx.Exec(`UPDATE invitations SET used=1 WHERE hash=?; UPDATE hosts SET revoked=0,verified=0,fingerprint=?,serial=?,generation=generation+1,os=?,os_version=?,addresses=?,agent_version=?,last_contact=? WHERE id=?`, security.Hash(b.Invitation), security.HashBytes(block.Bytes), serial, b.OS, b.OSVersion, core.Encode(b.Addresses), b.AgentVersion, s.Now().UnixMilli(), host)
	if e != nil {
		return e
	}
	if e = s.audit(tx, "enrollment", host, "agent.enroll", "", "completed"); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	write(w, 201, core.Identity{HostID: host, Certificate: cert, CA: string(s.CA.PEM), ExpiresAt: expiry})
	return nil
}
func (s *Server) revoke(w http.ResponseWriter, r *http.Request, u core.User) error {
	var b struct {
		Confirm string `json:"confirm"`
	}
	if e := decode(r, &b); e != nil {
		return e
	}
	host := r.PathValue("host")
	if b.Confirm != host {
		return fail(400, "confirm the exact host ID")
	}
	tx, e := s.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	res, e := tx.Exec(`UPDATE hosts SET revoked=1 WHERE id=?`, host)
	if e != nil {
		return e
	}
	n, _ := res.RowsAffected()
	if n != 1 {
		return fail(404, "host not found")
	}
	if _, e = tx.Exec(`INSERT INTO audit(at,actor,host_id,action,job_id,state) SELECT ?,actor,host_id,action,id,CASE WHEN state='queued' THEN 'cancelled:revocation' ELSE 'uncertain:revocation' END FROM jobs WHERE host_id=? AND state IN('queued','dispatched')`, s.Now().UnixMilli(), host); e != nil {
		return e
	}
	if _, e = tx.Exec(`UPDATE invitations SET used=1 WHERE host_id=?; UPDATE jobs SET state=CASE WHEN state='queued' THEN 'cancelled' ELSE 'uncertain' END,cancel=1,finished=? WHERE host_id=? AND state IN('queued','dispatched')`, host, s.Now().UnixMilli(), host); e != nil {
		return e
	}
	if e = s.audit(tx, u.ID, host, "agent.revoke", "", "completed"); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	s.closeHost(host)
	write(w, 200, map[string]bool{"revoked": true})
	return nil
}

func (s *Server) approve(w http.ResponseWriter, r *http.Request, u core.User) error {
	var b struct {
		Confirm                string `json:"confirm"`
		CertificateFingerprint string `json:"certificateFingerprint"`
	}
	if e := decode(r, &b); e != nil {
		return e
	}
	host := r.PathValue("host")
	if b.Confirm != host || len(b.CertificateFingerprint) != 64 {
		return fail(400, "verify the host ID and certificate fingerprint through a trusted channel")
	}
	tx, e := s.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	res, e := tx.Exec(`UPDATE hosts SET verified=1 WHERE id=? AND fingerprint=? AND revoked=0`, host, b.CertificateFingerprint)
	if e != nil {
		return e
	}
	n, _ := res.RowsAffected()
	if n != 1 {
		return fail(409, "identity changed or agent revoked")
	}
	if e = s.audit(tx, u.ID, host, "agent.approve", "", "verified"); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	write(w, 200, map[string]bool{"verified": true})
	return nil
}
func (s *Server) auditList(w http.ResponseWriter, r *http.Request, u core.User) error {
	rows, e := s.DB.Query(`SELECT id,at,actor,host_id,action,job_id,state FROM audit ORDER BY id DESC LIMIT 500`)
	if e != nil {
		return e
	}
	all := []core.Audit{}
	for rows.Next() {
		var a core.Audit
		if e = rows.Scan(&a.ID, &a.At, &a.Actor, &a.HostID, &a.Action, &a.JobID, &a.State); e != nil {
			rows.Close()
			return e
		}
		all = append(all, a)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	out := []core.Audit{}
	for _, a := range all {
		if u.Role == "admin" {
			out = append(out, a)
			continue
		}
		ok, e := s.allowed(u.ID, a.HostID, "host.read")
		if e != nil {
			return e
		}
		if ok && a.HostID != "" {
			out = append(out, a)
		}
	}
	write(w, 200, out)
	return nil
}
func validIdentifier(s string) bool {
	if s == "" || len(s) > 128 {
		return false
	}
	for _, c := range s {
		if !strings.ContainsRune("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.", c) {
			return false
		}
	}
	return true
}
