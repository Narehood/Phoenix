package github

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

const fixtureSHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const fixtureToken = "fixture-only-github-token-at-least-32-characters"

func fixtureBody(path string) string {
	switch {
	case path == "/repos/example/repo":
		return `{"full_name":"example/repo","private":true,"default_branch":"main","pushed_at":"2026-11-03T12:00:00Z"}`
	case strings.HasSuffix(path, "/pulls"):
		return fmt.Sprintf(`[{"number":7,"title":"Bump fixture-lib","updated_at":"2026-11-03T12:00:00Z","user":{"login":"dependabot[bot]"},"head":{"sha":%q}}]`, fixtureSHA)
	case strings.HasSuffix(path, "/pulls/7"):
		return fmt.Sprintf(`{"mergeable":true,"head":{"sha":%q}}`, fixtureSHA)
	case strings.HasSuffix(path, "/reviews"):
		return fmt.Sprintf(`[{"state":"APPROVED","commit_id":%q,"user":{"login":"reviewer"}}]`, fixtureSHA)
	case strings.HasSuffix(path, "/check-runs"):
		return `{"total_count":1,"check_runs":[{"status":"completed","conclusion":"success"}]}`
	case strings.HasSuffix(path, "/status"):
		return `{"state":"success","total_count":1,"statuses":[{"state":"success"}]}`
	case strings.HasSuffix(path, "/actions/runs"):
		return fmt.Sprintf(`{"total_count":1,"workflow_runs":[{"id":42,"name":"Linux","status":"completed","conclusion":"failure","head_sha":%q}]}`, fixtureSHA)
	case strings.HasSuffix(path, "/dependabot/alerts"):
		return `[{"number":2,"dependency":{"package":{"name":"fixture-lib","ecosystem":"npm"}},"security_advisory":{"summary":"Fixture advisory","severity":"high"},"security_vulnerability":{"first_patched_version":{"identifier":"2.0"}}}]`
	}
	return "null"
}

func response(body string, status int) *http.Response {
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}
}

func TestReadOnlyTLSCollectionCoverageAndIndependentCI(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != "GET" || r.Header.Get("Authorization") != "Bearer "+fixtureToken || r.Header.Get("X-GitHub-Api-Version") == "" {
			t.Error("unexpected request or credential contract")
		}
		if strings.HasSuffix(r.URL.Path, "/pulls") {
			w.Header().Set("Link", `<https://untrusted.invalid/steal>; rel="next"`)
		}
		if strings.HasSuffix(r.URL.Path, "/actions/runs") && (r.URL.Query().Get("branch") != "main" || r.URL.Query().Get("event") != "push") {
			t.Error("default branch CI mixed with PRs")
		}
		_, _ = io.WriteString(w, fixtureBody(r.URL.Path))
	}))
	server.TLS = &tls.Config{MinVersion: tls.VersionTLS13}
	server.StartTLS()
	defer server.Close()
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	transport := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS13}}
	defer transport.CloseIdleConnections()
	target, _ := url.Parse(server.URL)
	client := New(fixtureToken, roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Scheme != "https" || r.URL.Host != "api.github.com" {
			t.Fatal("unexpected production destination")
		}
		clone := r.Clone(r.Context())
		u := *r.URL
		clone.URL = &u
		clone.URL.Host = target.Host
		clone.Host = target.Host
		return transport.RoundTrip(clone)
	}))
	defer client.Close()
	s, e := client.Collect(context.Background(), "example/repo")
	if e != nil {
		t.Fatal(e)
	}
	if calls.Load() != 8 || !s.Repository.Private || !s.Pulls.Truncated || len(s.Pulls.Items) != 1 {
		t.Fatal("unexpected coverage", calls.Load(), s)
	}
	p := s.Pulls.Items[0]
	if !p.DependencyUpdate || p.UpdateKind != "security_or_version_unclassified" || p.Checks != "passing_observed" || p.ReviewState != "approval_observed" || p.Mergeable != "mergeable" {
		t.Fatal("PR observations lost", p)
	}
	if s.DefaultBranchCI.Items[0].Conclusion != "failure" || s.Alerts.Items[0].FixedIn != "2.0" || s.CodeScanning != "unsupported" {
		t.Fatal("independent sources lost")
	}
}

func TestPartialPermissionsAndMissingData(t *testing.T) {
	for _, missing := range []string{"denied-alerts", "null-alerts", "null-checks", "missing-statuses", "outdated-approval", "changed-head"} {
		t.Run(missing, func(t *testing.T) {
			client := New(fixtureToken, roundTripFunc(func(r *http.Request) (*http.Response, error) {
				body := fixtureBody(r.URL.Path)
				status := 200
				switch {
				case missing == "denied-alerts" && strings.HasSuffix(r.URL.Path, "/alerts"):
					status = 403
					body = fixtureToken
				case missing == "null-alerts" && strings.HasSuffix(r.URL.Path, "/alerts"):
					body = "null"
				case missing == "null-checks" && strings.HasSuffix(r.URL.Path, "/check-runs"):
					body = "null"
				case missing == "missing-statuses" && strings.HasSuffix(r.URL.Path, "/status"):
					body = `{"total_count":0}`
				case missing == "outdated-approval" && strings.HasSuffix(r.URL.Path, "/reviews"):
					body = `[{"state":"APPROVED","commit_id":"old","user":{"login":"reviewer"}}]`
				case missing == "changed-head" && strings.HasSuffix(r.URL.Path, "/pulls/7"):
					body = `{"mergeable":true,"head":{"sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}`
				}
				return response(body, status), nil
			}))
			defer client.Close()
			s, e := client.Collect(context.Background(), "example/repo")
			switch missing {
			case "denied-alerts", "null-alerts":
				if e == nil || s.Alerts.State == "ok" || len(s.Alerts.Items) != 0 || strings.Contains(e.Error(), fixtureToken) {
					t.Fatal("missing alerts looked healthy or leaked errors")
				}
			case "null-checks", "missing-statuses":
				if e == nil || s.Pulls.Items[0].Checks != "unknown" {
					t.Fatal("missing check coverage looked passing")
				}
			case "outdated-approval":
				if e != nil || s.Pulls.Items[0].ReviewState != "no_current_approval" {
					t.Fatal("old head approval counted")
				}
			case "changed-head":
				if s.Pulls.Items[0].Checks != "unknown" || s.Pulls.Items[0].ReviewState != "unknown" || s.Pulls.Items[0].Mergeable != "unknown" {
					t.Fatal("different PR heads were combined")
				}
			}
		})
	}
}

func TestFailuresRedirectsAndBudgets(t *testing.T) {
	for _, tc := range []struct {
		name        string
		status      int
		body, state string
	}{
		{"expired", 401, fixtureToken, "credential_expired"},
		{"permission", 403, fixtureToken, "permission_denied"},
		{"missing", 404, fixtureToken, "not_found_or_denied"},
		{"rate", 429, fixtureToken, "rate_limited"},
		{"secondary", 403, fixtureToken, "rate_limited"},
		{"oversized", 200, strings.Repeat("x", maxResponse+1), "invalid_response"},
		{"malformed", 200, "{bad", "invalid_response"},
		{"redirect", 302, "", "unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			client := New(fixtureToken, roundTripFunc(func(r *http.Request) (*http.Response, error) {
				calls++
				res := response(tc.body, tc.status)
				res.Header.Set("Location", "https://untrusted.invalid")
				if tc.name == "rate" || tc.name == "secondary" {
					res.Header.Set("Retry-After", "3600")
				}
				return res, nil
			}))
			defer client.Close()
			_, e := client.Collect(context.Background(), "example/repo")
			var api *APIError
			if !errors.As(e, &api) || api.State != tc.state || calls != 1 || strings.Contains(e.Error(), fixtureToken) {
				t.Fatal("failure escaped its safe bound", e, calls)
			}
			if tc.name == "rate" && api.RetryAt < time.Now().Add(59*time.Minute).UnixMilli() {
				t.Fatal("rate cooldown ignored")
			}
		})
	}
	calls := 0
	client := New(fixtureToken, roundTripFunc(func(r *http.Request) (*http.Response, error) { calls++; return response(`[]`, 200), nil }))
	defer client.Close()
	for i := 0; i < MaxRequests+5; i++ {
		var out any
		_, _ = client.get(context.Background(), "/fixture", &out)
	}
	if calls != MaxRequests {
		t.Fatal("request budget exceeded", calls)
	}
	for _, repo := range []string{"../secret", "owner/..", "owner/repo?token=secret", "https://example.com/repo", "owner/repo/extra"} {
		if ValidRepository(repo) {
			t.Fatal("accepted unsafe repository", repo)
		}
	}
}
