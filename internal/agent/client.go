package agent

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Narehood/Phoenix/internal/core"
	"github.com/Narehood/Phoenix/internal/security"
	"github.com/Narehood/Phoenix/internal/store"
)

var ErrRevoked = errors.New("agent identity rejected; operator intervention required")

type Config struct {
	ServerOrigin string `json:"serverOrigin"`
	AgentOrigin  string `json:"agentOrigin"`
	CAFile       string `json:"caFile"`
	Pin          string `json:"pin"`
	StateDir     string `json:"stateDir"`
	Policy       Policy `json:"policy"`
}
type Bundle struct {
	Identity   core.Identity `json:"identity"`
	PrivateKey string        `json:"privateKey"`
}
type Client struct {
	HTTP   *http.Client
	Origin string
}

func NewClient(c Config, bundle *Bundle) (*Client, error) {
	for _, origin := range []string{c.ServerOrigin, c.AgentOrigin} {
		u, e := url.Parse(origin)
		if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
			return nil, errors.New("agent endpoints must be exact HTTPS origins")
		}
	}
	var ca []byte
	var e error
	if c.CAFile != "" {
		ca, e = os.ReadFile(c.CAFile)
		if e != nil {
			return nil, e
		}
	}
	tc, e := security.ClientTLS(ca, c.Pin)
	if e != nil {
		return nil, e
	}
	origin := c.ServerOrigin
	if bundle != nil {
		cert, e := tls.X509KeyPair([]byte(bundle.Identity.Certificate), []byte(bundle.PrivateKey))
		if e != nil {
			return nil, e
		}
		tc.Certificates = []tls.Certificate{cert}
		origin = c.AgentOrigin
	}
	return &Client{HTTP: &http.Client{Transport: &http.Transport{TLSClientConfig: tc, Proxy: nil, MaxConnsPerHost: 2, MaxIdleConns: 2, IdleConnTimeout: 15 * time.Second, ResponseHeaderTimeout: 8 * time.Second}, Timeout: 12 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect refused") }}, Origin: origin}, nil
}
func (c *Client) post(ctx context.Context, path string, b, out any) error {
	body, e := json.Marshal(b)
	if e != nil {
		return e
	}
	req, e := http.NewRequestWithContext(ctx, "POST", c.Origin+path, bytes.NewReader(body))
	if e != nil {
		return errors.New("invalid agent endpoint")
	}
	req.Header.Set("Content-Type", "application/json")
	response, e := c.HTTP.Do(req)
	if e != nil {
		return errors.New("Phoenix connection or TLS verification failed")
	}
	defer response.Body.Close()
	if response.StatusCode == 401 || response.StatusCode == 403 {
		return ErrRevoked
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return errors.New("Phoenix refused agent request")
	}
	data, e := io.ReadAll(io.LimitReader(response.Body, 256*1024+1))
	if e != nil || len(data) > 256*1024 {
		return errors.New("agent response limit exceeded")
	}
	return json.Unmarshal(data, out)
}
func (c *Client) Exchange(ctx context.Context, b core.Exchange) (core.Delivery, error) {
	var d core.Delivery
	e := c.post(ctx, "/agent/exchange", b, &d)
	if e == nil && d.Protocol != core.Protocol {
		return d, errors.New("agent protocol mismatch")
	}
	return d, e
}
func (c *Client) Renew(ctx context.Context, csr string) (core.Identity, error) {
	var d core.Identity
	e := c.post(ctx, "/agent/renew", map[string]string{"csr": csr}, &d)
	return d, e
}
func saveBundle(dir string, b Bundle) error {
	if e := os.MkdirAll(dir, 0700); e != nil {
		return e
	}
	data, e := json.Marshal(b)
	if e != nil {
		return e
	}
	path := filepath.Join(dir, "identity.json")
	tmp := filepath.Join(dir, "identity.next")
	if e = security.WritePrivate(tmp, data); e != nil {
		return e
	}
	if e = os.Rename(tmp, path); e != nil {
		return e
	}
	if runtimeDir, e := os.Open(dir); e == nil {
		_ = runtimeDir.Sync()
		_ = runtimeDir.Close()
	}
	return nil
}
func LoadBundle(dir string) (Bundle, error) {
	var b Bundle
	data, e := os.ReadFile(filepath.Join(dir, "identity.json"))
	if e != nil {
		return b, e
	}
	e = json.Unmarshal(data, &b)
	return b, e
}
func Enroll(ctx context.Context, c Config, invitationFile string) error {
	if _, e := os.Stat(filepath.Join(c.StateDir, "identity.json")); !os.IsNotExist(e) {
		return errors.New("identity exists; deliberately archive revoked identity before re-enrollment")
	}
	osName, version, addresses, e := Metadata()
	if e != nil {
		return e
	}
	csr, key, e := security.NewCSR()
	if e != nil {
		return e
	}
	client, e := NewClient(c, nil)
	if e != nil {
		return e
	}
	token, e := os.ReadFile(invitationFile)
	if e != nil {
		return e
	}
	var identity core.Identity
	e = client.post(ctx, "/enroll", core.Enrollment{Invitation: strings.TrimSpace(string(token)), CSR: csr, OS: osName, OSVersion: version, Addresses: addresses, AgentVersion: core.Version}, &identity)
	if e != nil {
		return e
	}
	if _, e = tls.X509KeyPair([]byte(identity.Certificate), key); e != nil {
		return e
	}
	return saveBundle(c.StateDir, Bundle{Identity: identity, PrivateKey: string(key)})
}
func Run(ctx context.Context, c Config) error {
	platform, e := NewLinux(c.Policy)
	if e != nil {
		return e
	}
	bundle, e := LoadBundle(c.StateDir)
	if e != nil {
		return e
	}
	unlock, e := lockState(c.StateDir)
	if e != nil {
		return e
	}
	defer unlock()
	db, e := store.Open(filepath.Join(c.StateDir, "ledger.db"))
	if e != nil {
		return e
	}
	defer db.Close()
	engine := &Engine{DB: db, Platform: platform, Policy: c.Policy, Now: time.Now}
	if e = engine.Recover(); e != nil {
		return e
	}
	client, e := NewClient(c, &bundle)
	if e != nil {
		return e
	}
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	var running string
	var cancelJob context.CancelFunc
	var finished <-chan core.Result
	defer func() {
		if cancelJob != nil {
			cancelJob()
		}
	}()
	nextSample := time.Time{}
	backoff := time.Duration(0)
	nextAttempt := time.Time{}
	for {
		if finished != nil {
			select {
			case <-finished:
				running = ""
				finished = nil
				if cancelJob != nil {
					cancelJob()
					cancelJob = nil
				}
			default:
			}
		}
		if !time.Now().Before(nextAttempt) {
			if running == "" && bundle.Identity.ExpiresAt-time.Now().UnixMilli() < 6*60*60*1000 {
				csr, key, e := security.NewCSR()
				if e != nil {
					return e
				}
				identity, e := client.Renew(ctx, csr)
				if e != nil {
					if errors.Is(e, ErrRevoked) {
						return e
					}
				} else {
					if identity.HostID != bundle.Identity.HostID {
						return errors.New("renewed identity mismatch")
					}
					next := Bundle{Identity: identity, PrivateKey: string(key)}
					if _, e = tls.X509KeyPair([]byte(identity.Certificate), key); e != nil {
						return e
					}
					if e = saveBundle(c.StateDir, next); e != nil {
						return errors.New("renewal persisted incompletely; operator recovery required")
					}
					client.HTTP.CloseIdleConnections()
					bundle = next
					client, e = NewClient(c, &bundle)
					if e != nil {
						return e
					}
				}
			}
			receipts, e := engine.Pending()
			if e != nil {
				return e
			}
			request := core.Exchange{Protocol: core.Protocol, AgentVersion: core.Version, Receipts: receipts, RunningJob: running}
			if !time.Now().Before(nextSample) {
				bounded, cancel := context.WithTimeout(ctx, 5*time.Second)
				reading, e := platform.Collect(bounded)
				cancel()
				if e == nil {
					request.Reading = &reading
				}
				nextSample = time.Now().Add(30 * time.Second)
			}
			delivery, e := client.Exchange(ctx, request)
			if e != nil {
				if errors.Is(e, ErrRevoked) {
					return e
				}
				backoff *= 2
				if backoff < 2*time.Second {
					backoff = 2 * time.Second
				}
				if backoff > time.Minute {
					backoff = time.Minute
				}
				nextAttempt = time.Now().Add(backoff)
			} else {
				backoff = 0
				nextAttempt = time.Now().Add(2 * time.Second)
				if e = engine.Acknowledge(delivery.Acknowledged); e != nil {
					return e
				}
				if delivery.Cancel && cancelJob != nil {
					cancelJob()
				}
				if delivery.Job != nil && running == "" {
					job := *delivery.Job
					if job.HostID != bundle.Identity.HostID {
						return errors.New("job target identity mismatch")
					}
					jobCtx, cancel := context.WithCancel(ctx)
					cancelJob = cancel
					running = job.ID
					done := make(chan core.Result, 1)
					finished = done
					go func() { done <- engine.Run(jobCtx, job) }()
				}
			}
		}
		select {
		case <-ctx.Done():
			if cancelJob != nil {
				cancelJob()
				if finished != nil {
					select {
					case <-finished:
					case <-time.After(3 * time.Second):
					}
				}
			}
			return nil
		case <-tick.C:
		}
	}
}
