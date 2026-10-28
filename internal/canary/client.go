// Package canary implements only the read-only node contract documented in
// docs/canary.md. It does not assume a dashboard proxy or event webhook API.
package canary

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/Narehood/Phoenix/internal/security"
)

type Config struct {
	ID               string   `json:"id"`
	Origin           string   `json:"origin"`
	ExpectedNodeID   string   `json:"expectedNodeId"`
	ExpectedRevision string   `json:"expectedRevision"`
	AllowedIPs       []string `json:"allowedIps"`
	CAFile           string   `json:"caFile"`
	Pin              string   `json:"pin"`
	TokenFile        string   `json:"tokenFile,omitempty"`
}
type Observation struct {
	MonitorID        string  `json:"monitorId"`
	NodeID           string  `json:"nodeId"`
	State            string  `json:"state"`
	CheckedAt        int64   `json:"checkedAt"`
	LatencyMs        float64 `json:"latencyMs"`
	LatencyAvailable *bool   `json:"latencyAvailable,omitempty"`
}
type Monitor struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	IntervalMs int64    `json:"intervalMs"`
	NodeIDs    []string `json:"nodeIds"`
}
type MonitorView struct {
	Monitor        Monitor       `json:"monitor"`
	State          string        `json:"state"`
	Observations   []Observation `json:"observations"`
	UnknownNodes   int           `json:"unknownNodes"`
	ConfigConflict bool          `json:"configConflict"`
	MaintenanceIDs []string      `json:"maintenanceIds"`
}
type Overview struct {
	Build struct {
		SourceCommit  string `json:"sourceCommit"`
		ImageRevision string `json:"imageRevision"`
	} `json:"build"`
	Node struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"node"`
	Now         int64             `json:"now"`
	Monitors    []MonitorView     `json:"monitors"`
	Maintenance []json.RawMessage `json:"maintenance"`
	User        struct {
		Role string `json:"role"`
	} `json:"user"`
}
type Client struct {
	Config Config
	http   *http.Client
	token  string
}

func New(c Config, token string) (*Client, error) {
	u, e := url.Parse(c.Origin)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("Canary must be an exact HTTPS node origin")
	}
	if len(c.ExpectedRevision) != 40 || c.ExpectedNodeID == "" {
		return nil, errors.New("verified running revision and node identity required")
	}
	if len(token) < 32 || strings.ContainsAny(token, "\r\n") {
		return nil, errors.New("invalid viewer credential")
	}
	allowed := map[netip.Addr]bool{}
	for _, s := range c.AllowedIPs {
		ip, e := netip.ParseAddr(s)
		if e != nil {
			return nil, errors.New("explicit Canary destination IPs required")
		}
		ip = ip.Unmap()
		if ip.IsUnspecified() || ip.IsMulticast() || ip == netip.MustParseAddr("169.254.169.254") {
			return nil, errors.New("invalid Canary destination")
		}
		allowed[ip] = true
	}
	if len(allowed) == 0 {
		return nil, errors.New("explicit Canary destination IPs required")
	}
	var ca []byte
	if c.CAFile != "" {
		ca, e = os.ReadFile(c.CAFile)
		if e != nil {
			return nil, e
		}
	}
	tlsConfig, e := security.ClientTLS(ca, c.Pin)
	if e != nil {
		return nil, e
	}
	dialer := net.Dialer{Timeout: 3 * time.Second}
	transport := &http.Transport{TLSClientConfig: tlsConfig, MaxConnsPerHost: 2, MaxIdleConns: 2, IdleConnTimeout: 30 * time.Second, ResponseHeaderTimeout: 4 * time.Second, Proxy: nil, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, e := net.SplitHostPort(address)
		if e != nil || host != u.Hostname() {
			return nil, errors.New("destination origin rejected")
		}
		ips, e := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		if e != nil {
			return nil, errors.New("Canary DNS unavailable")
		}
		for _, ip := range ips {
			if !allowed[ip.Unmap()] {
				return nil, errors.New("Canary DNS resolved outside the allowlist")
			}
		}
		for _, ip := range ips {
			conn, e := dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
			if e == nil {
				return conn, nil
			}
		}
		return nil, errors.New("Canary unavailable")
	}}
	return &Client{Config: c, token: token, http: &http.Client{Transport: transport, Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("Canary redirects refused") }}}, nil
}
func (c *Client) get(ctx context.Context, path string, v any) error {
	req, e := http.NewRequestWithContext(ctx, http.MethodGet, c.Config.Origin+path, nil)
	if e != nil {
		return errors.New("invalid Canary request")
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	response, e := c.http.Do(req)
	if e != nil {
		return errors.New("Canary connection or identity validation failed")
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return fmt.Errorf("Canary returned HTTP %d", response.StatusCode)
	}
	b, e := io.ReadAll(io.LimitReader(response.Body, 2*1024*1024+1))
	if e != nil || len(b) > 2*1024*1024 {
		return errors.New("Canary response limit exceeded")
	}
	if e = json.Unmarshal(b, v); e != nil {
		return errors.New("invalid Canary contract")
	}
	return nil
}
func (c *Client) Overview(ctx context.Context) (Overview, error) {
	var out Overview
	if e := c.get(ctx, "/api/overview", &out); e != nil {
		return out, e
	}
	if out.Node.ID != c.Config.ExpectedNodeID || out.User.Role != "viewer" {
		return out, errors.New("Canary node identity or viewer role mismatch")
	}
	revision := out.Build.SourceCommit
	if revision == "" {
		revision = out.Build.ImageRevision
	}
	if revision != c.Config.ExpectedRevision {
		return out, errors.New("Canary running revision mismatch; reverify contract before activation")
	}
	if len(out.Monitors) > 500 || len(out.Maintenance) > 200 {
		return out, errors.New("Canary inventory limit exceeded")
	}
	return out, nil
}
func (c *Client) Monitors(ctx context.Context) ([]MonitorView, error) {
	out := []MonitorView{}
	e := c.get(ctx, "/api/monitors", &out)
	if len(out) > 500 {
		return nil, errors.New("Canary monitor limit exceeded")
	}
	return out, e
}
func (c *Client) History(ctx context.Context, id string) ([]Observation, error) {
	if id == "" || len(id) > 128 || strings.ContainsAny(id, "/?#%\\") {
		return nil, errors.New("invalid monitor ID")
	}
	out := []Observation{}
	e := c.get(ctx, "/api/monitors/"+url.PathEscape(id)+"/history?limit=100", &out)
	if len(out) > 100 {
		return nil, errors.New("Canary history limit exceeded")
	}
	return out, e
}
