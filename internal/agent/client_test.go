package agent

import (
	"context"
	"crypto/tls"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Narehood/Phoenix/internal/core"
	"github.com/Narehood/Phoenix/internal/security"
)

func TestEnrollmentAuthenticatesServerBeforeSendingInvitation(t *testing.T) {
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
	var sent atomic.Int32
	ts := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sent.Add(1)
		http.Redirect(w, r, "https://another-origin.invalid", http.StatusFound)
	}))
	ts.TLS = &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{pair}}
	ts.StartTLS()
	defer ts.Close()
	c := Config{ServerOrigin: ts.URL, AgentOrigin: ts.URL}
	client, e := NewClient(c, nil)
	if e != nil {
		t.Fatal(e)
	}
	if e = client.post(context.Background(), "/enroll", core.Enrollment{Invitation: "fixture invitation"}, &core.Identity{}); e == nil || sent.Load() != 0 {
		t.Fatal("invitation sent to untrusted server")
	}
	path := filepath.Join(t.TempDir(), "trusted-ca.pem")
	if e = os.WriteFile(path, ca.PEM, 0600); e != nil {
		t.Fatal(e)
	}
	c.CAFile = path
	c.Pin = strings.Repeat("0", 64)
	client, e = NewClient(c, nil)
	if e != nil {
		t.Fatal(e)
	}
	if e = client.post(context.Background(), "/enroll", core.Enrollment{Invitation: "fixture invitation"}, &core.Identity{}); e == nil || sent.Load() != 0 {
		t.Fatal("invitation sent before pin verification")
	}
	c.Pin = ""
	client, e = NewClient(c, nil)
	if e != nil {
		t.Fatal(e)
	}
	if e = client.post(context.Background(), "/enroll", core.Enrollment{Invitation: "fixture invitation"}, &core.Identity{}); e == nil || sent.Load() != 1 {
		t.Fatal("enrollment redirect not refused")
	}
	c.ServerOrigin = "http://127.0.0.1"
	if _, e = NewClient(c, nil); e == nil {
		t.Fatal("enrollment allowed HTTP")
	}
}
