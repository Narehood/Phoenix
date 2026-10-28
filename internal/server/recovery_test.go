package server

import (
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/pquerna/otp/totp"
)

func TestOfflineAdminRecoveryRevokesSessionsAndPreservesGrants(t *testing.T) {
	f := newFixture(t)
	f.web.Close()
	f.agents.Close()
	if e := f.s.DB.Close(); e != nil {
		t.Fatal(e)
	}
	path, e := RecoverAdmin(f.s.Config, f.user.Name)
	if e != nil {
		t.Fatal(e)
	}
	b, e := os.ReadFile(path)
	if e != nil {
		t.Fatal(e)
	}
	var credentials struct {
		Name     string `json:"name"`
		Password string `json:"password"`
		Secret   string `json:"totpSecret"`
	}
	if e = json.Unmarshal(b, &credentials); e != nil {
		t.Fatal(e)
	}
	s, e := New(f.s.Config)
	if e != nil {
		t.Fatal(e)
	}
	defer s.DB.Close()
	var count int
	if e = s.DB.QueryRow(`SELECT COUNT(*) FROM sessions`).Scan(&count); e != nil || count != 0 {
		t.Fatal("sessions survived recovery")
	}
	code, e := totp.GenerateCode(credentials.Secret, time.Now())
	if e != nil {
		t.Fatal(e)
	}
	user, e := s.authenticate(credentials.Name, credentials.Password, code)
	if e != nil || user.ID != f.user.ID {
		t.Fatal("recovered account cannot authenticate")
	}
	if e = s.DB.QueryRow(`SELECT COUNT(*) FROM grants WHERE user_id=?`, user.ID).Scan(&count); e != nil || count != 1 {
		t.Fatal("recovery changed administrator grants")
	}
	if _, e = RecoverAdmin(f.s.Config, f.user.Name); e == nil {
		t.Fatal("recovery overwrote existing private credentials")
	}
}
