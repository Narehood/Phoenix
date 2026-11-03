// Package github collects bounded, read-only repository health from GitHub.com.
package github

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const MaxRequests = 64
const maxResponse = 2 * 1024 * 1024

var repositoryPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}$`)
var shaPattern = regexp.MustCompile(`^[a-fA-F0-9]{40,64}$`)

func ValidRepository(s string) bool {
	return repositoryPattern.MatchString(s) && !strings.HasSuffix(s, "/.") && !strings.HasSuffix(s, "/..")
}

type APIError struct {
	State   string
	RetryAt int64
}

func (e *APIError) Error() string { return e.State }

type Collection[T any] struct {
	State     string `json:"state"`
	Truncated bool   `json:"truncated"`
	Items     []T    `json:"items"`
}

type Repository struct {
	FullName      string `json:"fullName"`
	URL           string `json:"url"`
	Private       bool   `json:"private"`
	Archived      bool   `json:"archived"`
	DefaultBranch string `json:"defaultBranch"`
	PushedAt      string `json:"pushedAt"`
}

type Pull struct {
	Number           int    `json:"number"`
	Title            string `json:"title"`
	URL              string `json:"url"`
	Author           string `json:"author"`
	Draft            bool   `json:"draft"`
	UpdatedAt        string `json:"updatedAt"`
	DependencyUpdate bool   `json:"dependencyUpdate"`
	UpdateKind       string `json:"updateKind"`
	Mergeable        string `json:"mergeable"`
	ReviewState      string `json:"reviewState"`
	Checks           string `json:"checks"`
}

type Workflow struct {
	Name       string `json:"name"`
	URL        string `json:"url"`
	Status     string `json:"status"`
	Conclusion string `json:"conclusion"`
	SHA        string `json:"sha"`
}

type Alert struct {
	Number    int    `json:"number"`
	Package   string `json:"package"`
	Ecosystem string `json:"ecosystem"`
	Severity  string `json:"severity"`
	Summary   string `json:"summary"`
	FixedIn   string `json:"fixedIn"`
	URL       string `json:"url"`
}

type Snapshot struct {
	Repository         Repository           `json:"repository"`
	Pulls              Collection[Pull]     `json:"pulls"`
	DefaultBranchCI    Collection[Workflow] `json:"defaultBranchCI"`
	Alerts             Collection[Alert]    `json:"alerts"`
	CodeScanning       string               `json:"codeScanning"`
	SecretScanning     string               `json:"secretScanning"`
	DependencyCoverage string               `json:"dependencyCoverage"`
}

type Client struct {
	http      *http.Client
	token     string
	remaining int
	blocked   *APIError
	issue     *APIError
}

// An injected transport is for temporary fixtures. Production always uses the
// fixed GitHub.com origin, normal trust roots, and refuses every redirect.
func New(token string, transport http.RoundTripper) *Client {
	if transport == nil {
		transport = &http.Transport{Proxy: http.ProxyFromEnvironment, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13}, MaxIdleConns: 2, MaxIdleConnsPerHost: 2, IdleConnTimeout: 15 * time.Second}
	}
	return &Client{token: token, remaining: MaxRequests, http: &http.Client{Transport: transport, Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect refused") }}}
}

func (c *Client) Close() { c.http.CloseIdleConnections() }

func (c *Client) remember(e error) string {
	if e == nil {
		return "ok"
	}
	var api *APIError
	if !errors.As(e, &api) {
		api = &APIError{State: "unavailable"}
	}
	if c.issue == nil || api.RetryAt > c.issue.RetryAt || api.State == "credential_expired" {
		c.issue = api
	}
	return api.State
}

func (c *Client) get(ctx context.Context, path string, out any) (bool, error) {
	if c.blocked != nil {
		return false, c.blocked
	}
	if c.remaining == 0 {
		return false, &APIError{State: "request_budget_exceeded"}
	}
	c.remaining--
	r, e := http.NewRequestWithContext(ctx, "GET", "https://api.github.com"+path, nil)
	if e != nil {
		return false, &APIError{State: "invalid_response"}
	}
	r.Header.Set("Authorization", "Bearer "+c.token)
	r.Header.Set("Accept", "application/vnd.github+json")
	r.Header.Set("X-GitHub-Api-Version", "2026-03-10")
	r.Header.Set("User-Agent", "Phoenix-maintenance")
	response, e := c.http.Do(r)
	if e != nil {
		return false, &APIError{State: "unavailable"}
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		a := &APIError{State: "unavailable"}
		switch response.StatusCode {
		case 401:
			a.State = "credential_expired"
		case 403:
			a.State = "permission_denied"
		case 404:
			a.State = "not_found_or_denied"
		}
		if response.StatusCode == 429 || response.StatusCode == 403 && (response.Header.Get("X-RateLimit-Remaining") == "0" || response.Header.Get("Retry-After") != "") {
			a.State = "rate_limited"
			now := time.Now()
			a.RetryAt = now.Add(15 * time.Minute).UnixMilli()
			if reset, err := strconv.ParseInt(response.Header.Get("X-RateLimit-Reset"), 10, 64); err == nil && reset > now.Unix() && reset < now.Add(24*time.Hour).Unix() {
				a.RetryAt = max(a.RetryAt, reset*1000)
			}
			if seconds, err := strconv.Atoi(response.Header.Get("Retry-After")); err == nil && seconds > 0 && seconds <= 86400 {
				a.RetryAt = max(a.RetryAt, now.Add(time.Duration(seconds)*time.Second).UnixMilli())
			}
		}
		if a.State == "rate_limited" || a.State == "credential_expired" {
			c.blocked = a
		}
		return false, a
	}
	b, e := io.ReadAll(io.LimitReader(response.Body, maxResponse+1))
	if e != nil || len(b) > maxResponse || json.Unmarshal(b, out) != nil {
		return false, &APIError{State: "invalid_response"}
	}
	return strings.Contains(response.Header.Get("Link"), `rel="next"`), nil
}

func (c *Client) Collect(ctx context.Context, repository string) (Snapshot, error) {
	s := Snapshot{Pulls: Collection[Pull]{State: "unknown", Items: []Pull{}}, DefaultBranchCI: Collection[Workflow]{State: "unknown", Items: []Workflow{}}, Alerts: Collection[Alert]{State: "unknown", Items: []Alert{}}, CodeScanning: "unsupported", SecretScanning: "unsupported", DependencyCoverage: "update_prs_and_dependabot_alerts_only"}
	if !ValidRepository(repository) {
		return s, &APIError{State: "invalid_repository"}
	}
	base := "/repos/" + repository
	var repo struct {
		FullName          string `json:"full_name"`
		Private, Archived bool
		DefaultBranch     string `json:"default_branch"`
		PushedAt          string `json:"pushed_at"`
	}
	if _, e := c.get(ctx, base, &repo); e != nil {
		return s, e
	}
	if !strings.EqualFold(repo.FullName, repository) || repo.DefaultBranch == "" || len(repo.DefaultBranch) > 255 {
		return s, &APIError{State: "invalid_response"}
	}
	s.Repository = Repository{FullName: repo.FullName, URL: "https://github.com/" + repository, Private: repo.Private, Archived: repo.Archived, DefaultBranch: repo.DefaultBranch, PushedAt: repo.PushedAt}
	var pulls []struct {
		Number    int
		Title     string
		UpdatedAt string `json:"updated_at"`
		Draft     bool
		User      struct{ Login string }
		Head      struct{ SHA string }
	}
	more, e := c.get(ctx, base+"/pulls?state=open&sort=updated&direction=desc&per_page=10", &pulls)
	if e == nil && pulls == nil {
		e = &APIError{State: "invalid_response"}
	}
	s.Pulls.State = c.remember(e)
	s.Pulls.Truncated = more || len(pulls) > 10
	if e == nil {
		for _, raw := range pulls[:min(len(pulls), 10)] {
			if raw.Number < 1 || !shaPattern.MatchString(raw.Head.SHA) {
				s.Pulls.State = "invalid_response"
				continue
			}
			p := Pull{Number: raw.Number, Title: clip(raw.Title, 512), URL: fmt.Sprintf("https://github.com/%s/pull/%d", repository, raw.Number), Author: clip(raw.User.Login, 80), Draft: raw.Draft, UpdatedAt: raw.UpdatedAt, Mergeable: "unknown", ReviewState: "unknown", Checks: "unknown", UpdateKind: "not_identified"}
			p.DependencyUpdate = raw.User.Login == "dependabot[bot]" || raw.User.Login == "renovate[bot]" || raw.User.Login == "renovate-bot"
			if p.DependencyUpdate {
				p.UpdateKind = "security_or_version_unclassified"
			}
			pullPath := fmt.Sprintf("%s/pulls/%d", base, p.Number)
			var detail struct {
				Mergeable *bool
				Head      struct{ SHA string }
			}
			_, err := c.get(ctx, pullPath, &detail)
			if err != nil {
				c.remember(err)
			} else if detail.Head.SHA == raw.Head.SHA && detail.Mergeable != nil {
				if *detail.Mergeable {
					p.Mergeable = "mergeable"
				} else {
					p.Mergeable = "conflicting"
				}
			}
			if err == nil && detail.Head.SHA == raw.Head.SHA {
				p.ReviewState = c.reviews(ctx, pullPath, raw.Head.SHA)
				p.Checks = c.checks(ctx, base, raw.Head.SHA)
			}
			s.Pulls.Items = append(s.Pulls.Items, p)
		}
	}
	var runs struct {
		Total int `json:"total_count"`
		Items []struct {
			Name, Status, Conclusion string
			ID                       int64
			SHA                      string `json:"head_sha"`
		} `json:"workflow_runs"`
	}
	more, e = c.get(ctx, base+"/actions/runs?branch="+url.QueryEscape(repo.DefaultBranch)+"&event=push&per_page=20", &runs)
	if e == nil && (runs.Items == nil || runs.Total < 0) {
		e = &APIError{State: "invalid_response"}
	}
	s.DefaultBranchCI.State = c.remember(e)
	s.DefaultBranchCI.Truncated = more || runs.Total > len(runs.Items) || len(runs.Items) > 20
	if e == nil {
		for _, run := range runs.Items[:min(len(runs.Items), 20)] {
			s.DefaultBranchCI.Items = append(s.DefaultBranchCI.Items, Workflow{Name: clip(run.Name, 160), URL: fmt.Sprintf("https://github.com/%s/actions/runs/%d", repository, run.ID), Status: clip(run.Status, 40), Conclusion: clip(run.Conclusion, 40), SHA: clip(run.SHA, 64)})
		}
	}
	var alerts []struct {
		Number     int
		Dependency struct {
			Package struct{ Name, Ecosystem string }
		}
		Advisory      struct{ Summary, Severity string } `json:"security_advisory"`
		Vulnerability struct {
			Patched *struct{ Identifier string } `json:"first_patched_version"`
		} `json:"security_vulnerability"`
	}
	more, e = c.get(ctx, base+"/dependabot/alerts?state=open&per_page=50", &alerts)
	if e == nil && alerts == nil {
		e = &APIError{State: "invalid_response"}
	}
	s.Alerts.State = c.remember(e)
	s.Alerts.Truncated = more || len(alerts) > 50
	if e == nil {
		for _, a := range alerts[:min(len(alerts), 50)] {
			fix := ""
			if a.Vulnerability.Patched != nil {
				fix = clip(a.Vulnerability.Patched.Identifier, 160)
			}
			s.Alerts.Items = append(s.Alerts.Items, Alert{Number: a.Number, Package: clip(a.Dependency.Package.Name, 160), Ecosystem: clip(a.Dependency.Package.Ecosystem, 80), Severity: clip(a.Advisory.Severity, 40), Summary: clip(a.Advisory.Summary, 512), FixedIn: fix, URL: fmt.Sprintf("https://github.com/%s/security/dependabot/%d", repository, a.Number)})
		}
	}
	if c.issue != nil {
		return s, c.issue
	}
	return s, nil
}

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

func (c *Client) reviews(ctx context.Context, path, sha string) string {
	var reviews []struct {
		State    string
		CommitID string `json:"commit_id"`
		User     struct{ Login string }
	}
	more, e := c.get(ctx, path+"/reviews?per_page=100", &reviews)
	if e != nil {
		return c.remember(e)
	}
	if reviews == nil {
		return c.remember(&APIError{State: "invalid_response"})
	}
	if more || len(reviews) > 100 {
		return "partial"
	}
	latest := map[string]string{}
	for _, r := range reviews {
		if r.State == "COMMENTED" || r.State == "PENDING" {
			continue
		}
		state := r.State
		if state == "APPROVED" && r.CommitID != sha {
			state = "OUTDATED"
		}
		latest[r.User.Login] = state
	}
	approved := false
	for _, state := range latest {
		if state == "CHANGES_REQUESTED" {
			return "changes_requested"
		}
		approved = approved || state == "APPROVED"
	}
	if approved {
		return "approval_observed"
	}
	return "no_current_approval"
}

func (c *Client) checks(ctx context.Context, base, sha string) string {
	var checks struct {
		Total int                                   `json:"total_count"`
		Items []struct{ Status, Conclusion string } `json:"check_runs"`
	}
	more, e := c.get(ctx, base+"/commits/"+sha+"/check-runs?per_page=100&filter=latest", &checks)
	checkState := c.remember(e)
	var statuses struct {
		State string
		Total int                      `json:"total_count"`
		Items []struct{ State string } `json:"statuses"`
	}
	moreStatus, statusError := c.get(ctx, base+"/commits/"+sha+"/status?per_page=100", &statuses)
	if e == nil && (checks.Items == nil || checks.Total < 0) {
		checkState = c.remember(&APIError{State: "invalid_response"})
	}
	if statusError == nil && (statuses.Items == nil || statuses.Total < 0) {
		statusError = &APIError{State: "invalid_response"}
	}
	statusState := c.remember(statusError)
	if checkState != "ok" || statusState != "ok" {
		return "unknown"
	}
	if more || moreStatus || checks.Total > len(checks.Items) || statuses.Total > len(statuses.Items) || len(checks.Items) > 100 || len(statuses.Items) > 100 {
		return "partial"
	}
	if len(checks.Items)+len(statuses.Items) == 0 {
		return "not_reported"
	}
	pending := false
	for _, c := range checks.Items {
		if c.Status != "completed" {
			pending = true
			continue
		}
		switch c.Conclusion {
		case "failure", "cancelled", "timed_out", "action_required", "stale":
			return "failing"
		case "success", "neutral", "skipped":
		default:
			pending = true
		}
	}
	for _, s := range statuses.Items {
		if s.State == "failure" || s.State == "error" {
			return "failing"
		}
		pending = pending || s.State != "success"
	}
	if pending {
		return "pending"
	}
	return "passing_observed"
}
