package server

import (
	"crypto/tls"
	"database/sql"
	"encoding/pem"
	"math"
	"net"
	"net/http"
	"time"

	"github.com/Narehood/Phoenix/internal/core"
	"github.com/Narehood/Phoenix/internal/security"
)

func (s *Server) AgentHandler() http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("POST /agent/exchange", endpoint(s.exchange))
	m.HandleFunc("POST /agent/renew", endpoint(s.renew))
	return m
}
func (s *Server) agentIdentity(r *http.Request) (string, string, error) {
	if r.TLS == nil || r.TLS.Version < tls.VersionTLS13 || len(r.TLS.VerifiedChains) == 0 || len(r.TLS.PeerCertificates) == 0 {
		return "", "", fail(401, "mutual TLS required")
	}
	cert := r.TLS.PeerCertificates[0]
	host := cert.Subject.CommonName
	if len(cert.URIs) != 1 || cert.URIs[0].String() != "spiffe://phoenix/host/"+host || !cert.NotAfter.After(s.Now()) || cert.NotBefore.After(s.Now()) {
		return "", "", fail(401, "invalid agent certificate")
	}
	var serial string
	var revoked bool
	e := s.DB.QueryRow(`SELECT serial,revoked FROM hosts WHERE id=?`, host).Scan(&serial, &revoked)
	if e != nil || revoked || serial != cert.SerialNumber.String() {
		return "", "", fail(401, "agent revoked or certificate superseded")
	}
	if c, ok := r.Context().Value(connKey{}).(net.Conn); ok {
		s.mu.Lock()
		s.connections[c] = host
		s.mu.Unlock()
	}
	return host, serial, nil
}
func validReading(t core.Reading, now int64) bool {
	for _, rate := range []*float64{t.NetworkRXBPS, t.NetworkTXBPS} {
		if rate != nil && (math.IsNaN(*rate) || math.IsInf(*rate, 0) || *rate < 0) {
			return false
		}
	}
	if t.MeasuredAt <= 0 || t.MeasuredAt > now+30000 || now-t.MeasuredAt > 86400000 || len(t.BootID) > 128 || len(t.Processes) > 100 || len(t.Services) > 100 || len(t.CollectionErrors) > 10 || math.IsNaN(t.UptimeSeconds) || math.IsInf(t.UptimeSeconds, 0) || t.UptimeSeconds < 0 || t.MemoryUsed > t.MemoryTotal || t.DiskUsed > t.DiskTotal {
		return false
	}
	if t.CPUPercent != nil && (math.IsNaN(*t.CPUPercent) || math.IsInf(*t.CPUPercent, 0) || *t.CPUPercent < 0 || *t.CPUPercent > 100) {
		return false
	}
	for _, p := range t.Processes {
		if len(p.Name) > 128 || p.PID < 0 {
			return false
		}
	}
	for _, v := range t.Services {
		if len(v.Name) > 128 || len(v.Active) > 32 || len(v.Load) > 32 || len(v.Sub) > 32 {
			return false
		}
	}
	for _, e := range t.CollectionErrors {
		if len(e) > 120 {
			return false
		}
	}
	return true
}
func validResult(r core.Result) bool {
	if len(r.Stdout)+len(r.Stderr) > core.OutputLimit || r.StartedAt < 0 || r.FinishedAt < r.StartedAt {
		return false
	}
	switch r.State {
	case "succeeded", "failed", "timed_out", "cancelled", "uncertain", "accepted":
		return true
	}
	return false
}
func (s *Server) exchange(w http.ResponseWriter, r *http.Request) error {
	host, serial, e := s.agentIdentity(r)
	if e != nil {
		return e
	}
	var b core.Exchange
	if e = decodeLimit(r, &b, 1024*1024); e != nil {
		return e
	}
	if b.Protocol != core.Protocol || len(b.AgentVersion) > 40 || len(b.Receipts) > 1 || len(b.RunningJob) > 64 {
		return fail(400, "invalid agent protocol payload")
	}
	now := s.Now().UnixMilli()
	if b.Reading != nil && !validReading(*b.Reading, now) {
		return fail(400, "invalid telemetry")
	}
	for _, v := range b.Receipts {
		if len(v.ID) == 0 || len(v.ID) > 64 || !validResult(v.Result) {
			return fail(400, "invalid job result")
		}
	}
	tx, e := s.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var revoked, verified bool
	var currentSerial string
	if e = tx.QueryRow(`SELECT serial,revoked,verified FROM hosts WHERE id=?`, host).Scan(&currentSerial, &revoked, &verified); e != nil {
		return e
	}
	if revoked || currentSerial != serial {
		return fail(401, "agent revoked or superseded")
	}
	out := core.Delivery{Protocol: core.Protocol, Acknowledged: []string{}, ServerTime: now}
	if _, e = tx.Exec(`UPDATE hosts SET last_contact=?,agent_version=? WHERE id=?`, now, b.AgentVersion, host); e != nil {
		return e
	}
	if b.Reading != nil {
		var previous int64
		_ = tx.QueryRow(`SELECT COALESCE(MAX(measured),0) FROM samples WHERE host_id=?`, host).Scan(&previous)
		if b.Reading.MeasuredAt > previous {
			if _, e = tx.Exec(`INSERT INTO samples(host_id,measured,collected,payload) VALUES(?,?,?,?)`, host, b.Reading.MeasuredAt, now, core.Encode(b.Reading)); e != nil {
				return e
			}
			if _, e = tx.Exec(`DELETE FROM samples WHERE host_id=? AND id NOT IN(SELECT id FROM samples WHERE host_id=? ORDER BY id DESC LIMIT ?)`, host, host, core.SampleLimit); e != nil {
				return e
			}
			if _, e = tx.Exec(`UPDATE hosts SET boot_id=? WHERE id=?`, b.Reading.BootID, host); e != nil {
				return e
			}
			if b.Reading.BootID != "" {
				if _, e = tx.Exec(`INSERT INTO audit(at,actor,host_id,action,job_id,state) SELECT ?,actor,host_id,action,id,'reboot_observed' FROM jobs WHERE host_id=? AND action='host.reboot' AND dispatched>0 AND dispatched<? AND boot_before<>'' AND boot_before<>? AND reboot_observed=0`, now, host, b.Reading.MeasuredAt, b.Reading.BootID); e != nil {
					return e
				}
				if _, e = tx.Exec(`UPDATE jobs SET reboot_observed=1 WHERE host_id=? AND action='host.reboot' AND dispatched>0 AND dispatched<? AND boot_before<>'' AND boot_before<>?`, host, b.Reading.MeasuredAt, b.Reading.BootID); e != nil {
					return e
				}
			}
		}
	}
	for _, receipt := range b.Receipts {
		j, e := scanJob(tx.QueryRow(`SELECT `+jobColumns+` FROM jobs WHERE id=? AND host_id=?`, receipt.ID, host))
		if e == sql.ErrNoRows {
			// A retained agent receipt can outlive the server's job retention.
			// Acknowledge it without trusting its result or blocking telemetry.
			if e = s.audit(tx, "agent:"+host, host, "receipt.unmatched", receipt.ID, "ignored"); e != nil {
				return e
			}
			out.Acknowledged = append(out.Acknowledged, receipt.ID)
			continue
		}
		if e != nil {
			return e
		}
		if j.DispatchedAt == 0 {
			return fail(409, "job was never dispatched")
		}
		if j.State == "dispatched" || j.State == "uncertain" {
			result := receipt.Result
			if result.State == "accepted" && j.Action != "host.reboot" {
				return fail(400, "accepted state is reserved for reboot")
			}
			state := result.State
			if _, e = tx.Exec(`UPDATE jobs SET state=?,result=?,finished=? WHERE id=?`, state, core.Encode(result), now, j.ID); e != nil {
				return e
			}
			if e = s.audit(tx, j.Actor, host, j.Action, j.ID, state); e != nil {
				return e
			}
		}
		out.Acknowledged = append(out.Acknowledged, j.ID)
	}
	if b.RunningJob != "" {
		var cancel bool
		var deadline int64
		e = tx.QueryRow(`SELECT cancel,deadline FROM jobs WHERE id=? AND host_id=?`, b.RunningJob, host).Scan(&cancel, &deadline)
		out.Cancel = e != nil || cancel || deadline <= now
		if e == nil {
			j, e := scanJob(tx.QueryRow(`SELECT `+jobColumns+` FROM jobs WHERE id=?`, b.RunningJob))
			if e != nil {
				return e
			}
			allowed, e := allowedDB(tx, j.Actor, host, j.Action)
			if e != nil {
				return e
			}
			if !allowed {
				out.Cancel = true
			}
		}
	} else {
		var active int
		if e = tx.QueryRow(`SELECT COUNT(*) FROM jobs WHERE host_id=? AND state='dispatched'`, host).Scan(&active); e != nil {
			return e
		}
		if active == 0 && verified {
			// Only queued commands can be dispatched; expired and unauthorized entries retire.
			for tries := 0; tries < 128; tries++ {
				j, e := scanJob(tx.QueryRow(`SELECT `+jobColumns+` FROM jobs WHERE host_id=? AND state='queued' ORDER BY created,id LIMIT 1`, host))
				if e == sql.ErrNoRows {
					break
				}
				if e != nil {
					return e
				}
				state := ""
				if j.ExpiresAt <= now {
					state = "expired"
				}
				allowed, e := allowedDB(tx, j.Actor, host, j.Action)
				if e != nil {
					return e
				}
				readable, e := allowedDB(tx, j.Actor, host, "host.read")
				if e != nil {
					return e
				}
				if !allowed || !readable {
					state = "denied"
				}
				if state != "" {
					if _, e = tx.Exec(`UPDATE jobs SET state=?,finished=? WHERE id=?`, state, now, j.ID); e != nil {
						return e
					}
					if e = s.audit(tx, j.Actor, host, j.Action, j.ID, state); e != nil {
						return e
					}
					continue
				}
				j.Deadline = now + int64(j.TimeoutSeconds)*1000
				if j.Deadline > j.ExpiresAt {
					j.Deadline = j.ExpiresAt
				}
				j.State = "dispatched"
				j.DispatchedAt = now
				if e = tx.QueryRow(`SELECT boot_id FROM hosts WHERE id=?`, host).Scan(&j.BootBefore); e != nil {
					return e
				}
				if _, e = tx.Exec(`UPDATE jobs SET state='dispatched',dispatched=?,deadline=?,boot_before=? WHERE id=?`, now, j.Deadline, j.BootBefore, j.ID); e != nil {
					return e
				}
				if e = s.audit(tx, j.Actor, host, j.Action, j.ID, "dispatched"); e != nil {
					return e
				}
				out.Job = &j
				break
			}
		}
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	write(w, 200, out)
	return nil
}
func (s *Server) renew(w http.ResponseWriter, r *http.Request) error {
	host, old, e := s.agentIdentity(r)
	if e != nil {
		return e
	}
	var b struct {
		CSR string `json:"csr"`
	}
	if e = decode(r, &b); e != nil {
		return e
	}
	cert, serial, expiry, e := s.CA.Sign(b.CSR, host, 24*time.Hour)
	if e != nil {
		return fail(400, "invalid CSR")
	}
	tx, e := s.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	block, _ := pem.Decode([]byte(cert))
	if block == nil {
		return fail(503, "certificate encoding unavailable")
	}
	res, e := tx.Exec(`UPDATE hosts SET serial=?,fingerprint=? WHERE id=? AND serial=? AND revoked=0`, serial, security.HashBytes(block.Bytes), host, old)
	if e != nil {
		return e
	}
	n, _ := res.RowsAffected()
	if n != 1 {
		return fail(401, "agent superseded")
	}
	if e = s.audit(tx, "agent", host, "certificate.rotate", "", "completed"); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	w.Header().Set("Connection", "close")
	if c, ok := r.Context().Value(connKey{}).(net.Conn); ok {
		s.mu.Lock()
		for other, id := range s.connections {
			if id == host && other != c {
				_ = other.Close()
			}
		}
		s.mu.Unlock()
	}
	write(w, 200, core.Identity{HostID: host, Certificate: cert, CA: string(s.CA.PEM), ExpiresAt: expiry})
	return nil
}
