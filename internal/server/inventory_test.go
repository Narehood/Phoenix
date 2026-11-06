package server

import (
	"testing"

	"github.com/Narehood/Phoenix/internal/core"
)

func TestInventoryReplacementPreservesConcurrentGroups(t *testing.T) {
	f := newFixture(t)
	a := f.newAgent("inventory-fixture")
	path := "/api/hosts/" + a.id
	var read struct {
		Host core.Host `json:"host"`
	}
	f.call("GET", path, nil, 200, &read)
	initial := read.Host.InventoryRevision
	initialGroups := append([]string{}, read.Host.Groups...)
	if len(initial) != 64 {
		t.Fatal("host read did not include an inventory revision")
	}
	if _, err := f.s.DB.Exec(`UPDATE hosts SET last_contact=last_contact+1 WHERE id=?`, a.id); err != nil {
		t.Fatal(err)
	}
	f.call("GET", path, nil, 200, &read)
	if read.Host.InventoryRevision != initial {
		t.Fatal("agent contact changed the editable-inventory revision")
	}
	f.call("PATCH", path, map[string]any{"name": "missing-precondition", "tags": []string{}, "groups": []string{}}, 428, nil)
	var saved core.Host
	f.call("PATCH", path, map[string]any{"name": "first-editor", "tags": []string{"retained"}, "groups": []string{}, "inventoryRevision": initial}, 200, &saved)
	if saved.InventoryRevision == initial {
		t.Fatal("inventory revision did not change with editable values")
	}
	// A second editor's older form must not restore a removed permission scope.
	f.call("PATCH", path, map[string]any{"name": "stale-editor", "tags": []string{}, "groups": initialGroups, "inventoryRevision": initial}, 409, nil)
	f.call("GET", path, nil, 200, &read)
	if read.Host.Name != "first-editor" || len(read.Host.Groups) != 0 || len(read.Host.Tags) != 1 || read.Host.Tags[0] != "retained" || read.Host.InventoryRevision != saved.InventoryRevision {
		t.Fatal("stale inventory replacement changed the saved fields")
	}
	var audits int
	if err := f.s.DB.QueryRow(`SELECT COUNT(*) FROM audit WHERE host_id=? AND action='inventory.update'`, a.id).Scan(&audits); err != nil || audits != 1 {
		t.Fatal("rejected inventory replacement recorded success", audits, err)
	}
	f.call("PATCH", path, map[string]any{"name": "reviewed-editor", "tags": []string{"retained"}, "groups": []string{}, "inventoryRevision": saved.InventoryRevision}, 200, &saved)
	if saved.Name != "reviewed-editor" || len(saved.Groups) != 0 {
		t.Fatal("reviewed replacement failed to preserve the newer scope decision")
	}
}
