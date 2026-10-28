package server

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Narehood/Phoenix/internal/canary"
	"github.com/Narehood/Phoenix/internal/core"
)

func TestCanarySourceIdentityMultipleMappingsAndOutage(t *testing.T) {
	f := newFixture(t)
	a := f.newAgent("Mapped Debian")
	cert, key, e := f.s.CA.ServerCertificate([]string{"127.0.0.1"})
	if e != nil {
		t.Fatal(e)
	}
	pair, e := tls.X509KeyPair(cert, key)
	if e != nil {
		t.Fatal(e)
	}
	caFile := filepath.Join(t.TempDir(), "fixture-ca.pem")
	if e = os.WriteFile(caFile, f.s.CA.PEM, 0600); e != nil {
		t.Fatal(e)
	}
	var unavailable atomic.Bool
	token := "fixture-only-viewer-token-at-least-32-characters"
	revision := "3bb63a5f6a3c721ce4ccb0c0667de1d1dc65b974"
	source := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Path != "/api/overview" || r.Header.Get("Authorization") != "Bearer "+token {
			t.Error("adapter used unexpected contract")
			w.WriteHeader(400)
			return
		}
		if unavailable.Load() {
			w.WriteHeader(503)
			return
		}
		o := canary.Overview{}
		o.Node.ID = "node-a"
		o.Node.Name = "Debian node"
		o.Build.SourceCommit = revision
		o.User.Role = "viewer"
		o.Now = f.now.UnixMilli()
		o.Monitors = []canary.MonitorView{{Monitor: canary.Monitor{ID: "same-id", Name: "same-name", IntervalMs: 30000, NodeIDs: []string{"perspective-a", "perspective-b"}}, State: "down", Observations: []canary.Observation{{MonitorID: "same-id", NodeID: "perspective-a", State: "up", CheckedAt: o.Now}, {MonitorID: "same-id", NodeID: "perspective-b", State: "down", CheckedAt: o.Now}}, MaintenanceIDs: []string{"maint-a"}}, {Monitor: canary.Monitor{ID: "second-id", Name: "Second monitor"}, State: "unknown"}}
		_ = json.NewEncoder(w).Encode(o)
	}))
	source.TLS = &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{pair}}
	source.StartTLS()
	defer source.Close()
	for _, id := range []string{"source-a", "source-b"} {
		c := canary.Config{ID: id, Origin: source.URL, ExpectedNodeID: "node-a", ExpectedRevision: revision, AllowedIPs: []string{"127.0.0.1"}, CAFile: caFile}
		if _, e = f.s.DB.Exec(`INSERT INTO canary_sources(id,config,token) VALUES(?,?,?)`, id, core.Encode(c), f.s.Vault.Seal(token, "canary:"+id)); e != nil {
			t.Fatal(e)
		}
	}
	sources, e := f.s.sources()
	if e != nil {
		t.Fatal(e)
	}
	for _, s := range sources {
		if e = f.s.pollSource(context.Background(), s); e != nil {
			t.Fatal(e)
		}
	}
	f.call("PUT", "/api/hosts/"+a.id+"/mappings", map[string]any{"mappings": []map[string]string{{"sourceId": "source-a", "monitorId": "same-id"}, {"sourceId": "source-a", "monitorId": "second-id"}, {"sourceId": "source-b", "monitorId": "same-id"}}}, 200, nil)
	var out struct {
		Sources []struct {
			ID        string               `json:"id"`
			Freshness string               `json:"freshness"`
			Monitors  []canary.MonitorView `json:"monitors"`
		} `json:"sources"`
		Mappings []mapping `json:"mappings"`
	}
	f.call("GET", "/api/canary", nil, 200, &out)
	if len(out.Sources) != 2 || len(out.Mappings) != 3 || len(out.Sources[0].Monitors[0].Observations) != 2 {
		t.Fatal("unrelated sources or node perspectives merged")
	}
	if strings.Contains(core.Encode(out), token) {
		t.Fatal("Canary token leaked to browser")
	}
	unavailable.Store(true)
	if e = f.s.pollSource(context.Background(), sources[0]); e == nil {
		t.Fatal("source outage ignored")
	}
	f.call("GET", "/api/canary", nil, 200, &out)
	if out.Sources[0].Freshness != "stale" {
		t.Fatal("source outage reported as healthy")
	}
	h, e := f.s.host(a.id)
	if e != nil || h.Connectivity != "connected" {
		t.Fatal("Canary outage changed independent agent connectivity")
	}
}
