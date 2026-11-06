package server

import (
	"testing"

	"github.com/Narehood/Phoenix/internal/core"
)

func TestGrantReplacementPreservesConcurrentRevocation(t *testing.T) {
	f := newFixture(t)
	var account struct {
		User core.User `json:"user"`
	}
	f.call("POST", "/api/users", map[string]string{"name": "grant-conflict-operator", "role": "operator", "password": "temporary fixture password"}, 201, &account)
	path := "/api/users/" + account.User.ID + "/grants"
	read := core.Grant{ScopeType: "host", Scope: "fixture-host", Action: "host.read"}
	f.call("PUT", path, map[string]any{"grants": []core.Grant{read}}, 428, nil)
	f.replaceGrants(account.User.ID, []core.Grant{read})
	var original struct {
		Grants []core.Grant `json:"grants"`
	}
	f.call("GET", path, nil, 200, &original)
	// Another editor revokes access after the first editor loaded its snapshot.
	f.replaceGrants(account.User.ID, []core.Grant{})
	f.call("PUT", path, map[string]any{
		"grants":         []core.Grant{read, {ScopeType: "host", Scope: "fixture-host", Action: "diagnostic"}},
		"expectedGrants": original.Grants,
	}, 409, nil)
	var saved struct {
		Grants []core.Grant `json:"grants"`
	}
	f.call("GET", path, nil, 200, &saved)
	if len(saved.Grants) != 0 {
		t.Fatal("stale replacement restored revoked access")
	}
	// Reconciliation starts from the newly loaded set and can add only the
	// explicitly intended diagnostic grant without restoring host.read.
	f.call("PUT", path, map[string]any{
		"grants":         []core.Grant{{ScopeType: "host", Scope: "fixture-host", Action: "diagnostic"}},
		"expectedGrants": saved.Grants,
	}, 200, nil)
	f.call("GET", path, nil, 200, &saved)
	if len(saved.Grants) != 1 || saved.Grants[0].Action != "diagnostic" {
		t.Fatal("reconciled replacement did not preserve the intended grant set")
	}
}
