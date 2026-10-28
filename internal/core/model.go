package core

import (
	"context"
	"encoding/json"
	"time"
)

const Protocol = 1
const Version = "0.1.0-dev"
const OutputLimit = 64 * 1024
const SampleLimit = 240

type Host struct {
	ID                     string   `json:"id"`
	Name                   string   `json:"name"`
	OS                     string   `json:"os"`
	OSVersion              string   `json:"osVersion"`
	Addresses              []string `json:"addresses"`
	Tags                   []string `json:"tags"`
	Groups                 []string `json:"groups"`
	ConnectionMethod       string   `json:"connectionMethod"`
	AgentVersion           string   `json:"agentVersion"`
	LastContact            int64    `json:"lastContact"`
	Revoked                bool     `json:"revoked"`
	Verified               bool     `json:"verified"`
	CertificateFingerprint string   `json:"certificateFingerprint"`
	Generation             int      `json:"generation"`
	BootID                 string   `json:"bootId"`
	Connectivity           string   `json:"connectivity"`
	Freshness              string   `json:"freshness"`
	ResourceHealth         string   `json:"resourceHealth"`
	Latest                 *Sample  `json:"latest"`
}
type Reading struct {
	MeasuredAt       int64     `json:"measuredAt"`
	BootID           string    `json:"bootId"`
	CPUPercent       *float64  `json:"cpuPercent"`
	MemoryUsed       uint64    `json:"memoryUsed"`
	MemoryTotal      uint64    `json:"memoryTotal"`
	DiskUsed         uint64    `json:"diskUsed"`
	DiskTotal        uint64    `json:"diskTotal"`
	NetworkRX        uint64    `json:"networkRx"`
	NetworkTX        uint64    `json:"networkTx"`
	NetworkRXBPS     *float64  `json:"networkRxBps"`
	NetworkTXBPS     *float64  `json:"networkTxBps"`
	UptimeSeconds    float64   `json:"uptimeSeconds"`
	Processes        []Process `json:"processes"`
	Services         []Service `json:"services"`
	CollectionErrors []string  `json:"collectionErrors"`
}
type Sample struct {
	Reading
	CollectedAt int64 `json:"collectedAt"`
}
type Process struct {
	PID         int    `json:"pid"`
	Name        string `json:"name"`
	MemoryBytes uint64 `json:"memoryBytes"`
}
type Service struct {
	Name   string `json:"name"`
	Load   string `json:"load"`
	Active string `json:"active"`
	Sub    string `json:"sub"`
}
type Result struct {
	State      string `json:"state"`
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	ExitCode   int    `json:"exitCode"`
	StartedAt  int64  `json:"startedAt"`
	FinishedAt int64  `json:"finishedAt"`
	Truncated  bool   `json:"truncated"`
}
type Job struct {
	ID              string  `json:"id"`
	Actor           string  `json:"actor"`
	HostID          string  `json:"hostId"`
	Action          string  `json:"action"`
	Args            Args    `json:"args"`
	State           string  `json:"state"`
	CreatedAt       int64   `json:"createdAt"`
	ExpiresAt       int64   `json:"expiresAt"`
	Deadline        int64   `json:"deadline"`
	TimeoutSeconds  int     `json:"timeoutSeconds"`
	DispatchedAt    int64   `json:"dispatchedAt"`
	FinishedAt      int64   `json:"finishedAt"`
	CancelRequested bool    `json:"cancelRequested"`
	BootBefore      string  `json:"bootBefore"`
	RebootObserved  bool    `json:"rebootObserved"`
	Result          *Result `json:"result,omitempty"`
}
type Args struct {
	Service    string `json:"service,omitempty"`
	Diagnostic string `json:"diagnostic,omitempty"`
}
type User struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Role   string `json:"role"`
	Active bool   `json:"active"`
}
type Grant struct {
	ScopeType string `json:"scopeType"`
	Scope     string `json:"scope"`
	Action    string `json:"action"`
}
type Audit struct {
	ID     int64  `json:"id"`
	At     int64  `json:"at"`
	Actor  string `json:"actor"`
	HostID string `json:"hostId"`
	Action string `json:"action"`
	JobID  string `json:"jobId"`
	State  string `json:"state"`
}
type Enrollment struct {
	Invitation   string   `json:"invitation"`
	CSR          string   `json:"csr"`
	OS           string   `json:"os"`
	OSVersion    string   `json:"osVersion"`
	Addresses    []string `json:"addresses"`
	AgentVersion string   `json:"agentVersion"`
}
type Identity struct {
	HostID      string `json:"hostId"`
	Certificate string `json:"certificate"`
	CA          string `json:"ca"`
	ExpiresAt   int64  `json:"expiresAt"`
}
type Receipt struct {
	ID     string `json:"id"`
	Result Result `json:"result"`
}
type Exchange struct {
	Protocol     int       `json:"protocol"`
	AgentVersion string    `json:"agentVersion"`
	Reading      *Reading  `json:"reading,omitempty"`
	Receipts     []Receipt `json:"receipts"`
	RunningJob   string    `json:"runningJob,omitempty"`
}
type Delivery struct {
	Protocol     int      `json:"protocol"`
	Job          *Job     `json:"job,omitempty"`
	Acknowledged []string `json:"acknowledged"`
	Cancel       bool     `json:"cancel"`
	ServerTime   int64    `json:"serverTime"`
}

// Platform does not confer permission; callers and each implementation enforce policy.
type Platform interface {
	Collect(context.Context) (Reading, error)
	Execute(context.Context, Job) Result
}

// Transport is independent of host inventory, permissions and job persistence.
type Transport interface {
	Exchange(context.Context, Exchange) (Delivery, error)
	Renew(context.Context, string) (Identity, error)
}
type Clock func() time.Time

func Encode(v any) string { b, _ := json.Marshal(v); return string(b) }
func Millis() int64       { return time.Now().UnixMilli() }
