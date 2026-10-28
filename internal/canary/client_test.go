package canary

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

	"github.com/Narehood/Phoenix/internal/security"
)

const fixtureRevision = "3bb63a5f6a3c721ce4ccb0c0667de1d1dc65b974"
const fixtureToken = "fixture-viewer-credential-not-a-real-secret"

func TestVerifiedNodeContractsAndFailureBoundaries(t *testing.T) {
	ca, e := security.NewCA()
	if e != nil {
		t.Fatal(e)
	}
	cert, key, e := ca.ServerCertificate([]string{"127.0.0.1"})
	if e != nil {
		t.Fatal(e)
	}
	pair, e := tls.X509KeyPair(cert, key)
	if e != nil {
		t.Fatal(e)
	}
	caPath := filepath.Join(t.TempDir(), "trusted-ca.pem")
	if e = os.WriteFile(caPath, ca.PEM, 0600); e != nil {
		t.Fatal(e)
	}
	var calls atomic.Int32
	var mode atomic.Value
	mode.Store("valid")
	mux := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		mode := mode.Load().(string)
		if r.Header.Get("Authorization") != "Bearer "+fixtureToken || r.Method != "GET" {
			t.Error("viewer GET contract violated")
			w.WriteHeader(401)
			return
		}
		if mode == "redirect" {
			http.Redirect(w, r, "https://other.invalid", 302)
			return
		}
		if mode == "oversize" {
			_, _ = w.Write([]byte(strings.Repeat(" ", 2*1024*1024+1)))
			return
		}
		switch r.URL.Path {
		case "/api/overview":
			role := "viewer"
			revision := fixtureRevision
			if mode == "admin" {
				role = "admin"
			}
			if mode == "revision" {
				revision = strings.Repeat("0", 40)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"node": map[string]string{"id": "fixture-node", "name": "Fixture node"}, "build": map[string]string{"sourceCommit": revision}, "now": int64(1234), "user": map[string]string{"role": role}, "monitors": []any{map[string]any{"monitor": map[string]any{"id": "monitor-a", "name": "Debian", "intervalMs": 30000, "nodeIds": []string{"fixture-node"}}, "state": "up", "observations": []map[string]any{{"monitorId": "monitor-a", "nodeId": "fixture-node", "state": "up", "checkedAt": int64(1200)}}, "maintenanceIds": []string{"maintenance-a"}}}})
		case "/api/monitors":
			_, _ = w.Write([]byte(`[]`))
		case "/api/monitors/monitor-a/history":
			if r.URL.Query().Get("limit") != "100" {
				t.Error("history not bounded")
			}
			_, _ = w.Write([]byte(`[{"monitorId":"monitor-a","nodeId":"fixture-node","state":"up","checkedAt":1200}]`))
		default:
			t.Error("invented endpoint: " + r.URL.Path)
			w.WriteHeader(404)
		}
	})
	ts := httptest.NewUnstartedServer(mux)
	ts.TLS = &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{pair}}
	ts.StartTLS()
	defer ts.Close()
	config := Config{ID: "fixture-source", Origin: ts.URL, ExpectedNodeID: "fixture-node", ExpectedRevision: fixtureRevision, AllowedIPs: []string{"127.0.0.1"}, CAFile: caPath}
	client, e := New(config, fixtureToken)
	if e != nil {
		t.Fatal(e)
	}
	overview, e := client.Overview(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	if len(overview.Monitors) != 1 || overview.Monitors[0].Observations[0].NodeID != "fixture-node" || overview.Monitors[0].MaintenanceIDs[0] != "maintenance-a" {
		t.Fatal("source perspective or maintenance lost")
	}
	if _, e = client.Monitors(context.Background()); e != nil {
		t.Fatal(e)
	}
	if _, e = client.History(context.Background(), "monitor-a"); e != nil {
		t.Fatal(e)
	}
	for _, failure := range []string{"admin", "revision", "redirect", "oversize"} {
		mode.Store(failure)
		if _, e = client.Overview(context.Background()); e == nil {
			t.Fatal("accepted invalid source: " + failure)
		}
	}
	mode.Store("valid")
	wrong := config
	wrong.Pin = strings.Repeat("0", 64)
	bad, e := New(wrong, fixtureToken)
	if e != nil {
		t.Fatal(e)
	}
	before := calls.Load()
	if _, e = bad.Overview(context.Background()); e == nil || calls.Load() != before {
		t.Fatal("credential sent before pin verification")
	}
	wrong = config
	wrong.AllowedIPs = []string{"192.0.2.1"}
	bad, e = New(wrong, fixtureToken)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = bad.Overview(context.Background()); e == nil {
		t.Fatal("destination allowlist bypassed")
	}
	wrong = config
	wrong.CAFile = ""
	bad, e = New(wrong, fixtureToken)
	if e != nil {
		t.Fatal(e)
	}
	before = calls.Load()
	if _, e = bad.Overview(context.Background()); e == nil || calls.Load() != before {
		t.Fatal("credential sent to untrusted server")
	}
	wrong = config
	wrong.Origin = "http://127.0.0.1"
	if _, e = New(wrong, fixtureToken); e == nil {
		t.Fatal("HTTP accepted")
	}
	wrong = config
	wrong.ExpectedRevision = ""
	if _, e = New(wrong, fixtureToken); e == nil {
		t.Fatal("unverified deployed revision accepted")
	}
}
