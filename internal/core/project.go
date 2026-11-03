package core

// MaintenanceContract versions the project capability response independently of
// the host/agent protocol. Capabilities describe availability, not authorization
// to data or operations in a connected application.
const MaintenanceContract = 1

type Project struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Modules     []string `json:"modules"`
	Archived    bool     `json:"archived"`
	Revision    int64    `json:"revision"`
	CreatedAt   int64    `json:"createdAt"`
	UpdatedAt   int64    `json:"updatedAt"`
}

type ProjectCapability struct {
	ID      string   `json:"id"`
	Enabled bool     `json:"enabled"`
	State   string   `json:"state"`
	Reason  string   `json:"reason"`
	Actions []string `json:"actions"`
}

type ProjectCapabilities struct {
	ContractVersion int                 `json:"contractVersion"`
	ProjectID       string              `json:"projectId"`
	Revision        int64               `json:"revision"`
	Permissions     []string            `json:"permissions"`
	Modules         []ProjectCapability `json:"modules"`
}
