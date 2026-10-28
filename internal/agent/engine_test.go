package agent

import (
	"context"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Narehood/Phoenix/internal/core"
	"github.com/Narehood/Phoenix/internal/store"
)

type fixturePlatform struct {
	calls    atomic.Int32
	block    bool
	accepted bool
}

func (p *fixturePlatform) Collect(context.Context) (core.Reading, error) { return core.Reading{}, nil }
func (p *fixturePlatform) Execute(ctx context.Context, j core.Job) core.Result {
	p.calls.Add(1)
	if p.block {
		<-ctx.Done()
		state := "timed_out"
		if ctx.Err() == context.Canceled {
			state = "cancelled"
		}
		return core.Result{State: state, ExitCode: -1}
	}
	if p.accepted {
		return core.Result{State: "accepted"}
	}
	return core.Result{State: "succeeded", Stdout: "fixture only", ExitCode: 0}
}
func engineFixture(t *testing.T, p *fixturePlatform) *Engine {
	t.Helper()
	db, e := store.Open(filepath.Join(t.TempDir(), "ledger.db"))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { db.Close() })
	return &Engine{DB: db, Platform: p, Policy: Policy{RestartServices: []string{"fixture.service"}, AllowReboot: true}, Now: time.Now}
}
func fixtureJob(id string) core.Job {
	return core.Job{ID: id, HostID: "fixture", Action: "diagnostic", Args: core.Args{Diagnostic: "system.summary"}, ExpiresAt: time.Now().Add(time.Minute).UnixMilli(), Deadline: time.Now().Add(time.Second).UnixMilli()}
}
func TestDurableDuplicateJobAndInterruptedReceipt(t *testing.T) {
	p := &fixturePlatform{}
	e := engineFixture(t, p)
	j := fixtureJob("durable-id")
	first := e.Run(context.Background(), j)
	again := e.Run(context.Background(), j)
	if first.State != "succeeded" || again.Stdout != first.Stdout || p.calls.Load() != 1 {
		t.Fatal("duplicate execution")
	}
	receipts, err := e.Pending()
	if err != nil || len(receipts) != 1 {
		t.Fatal("missing durable receipt")
	}
	reopened := &Engine{DB: e.DB, Platform: p, Policy: e.Policy, Now: time.Now}
	if err = reopened.Recover(); err != nil {
		t.Fatal(err)
	}
	if reopened.Run(context.Background(), j).State != "succeeded" || p.calls.Load() != 1 {
		t.Fatal("restart repeated completed job")
	}
	if err = e.Acknowledge([]string{j.ID}); err != nil {
		t.Fatal(err)
	}
	receipts, err = e.Pending()
	if err != nil || len(receipts) != 0 {
		t.Fatal("acknowledgement not durable")
	}
	if _, err = e.DB.Exec(`INSERT INTO agent_jobs(id,state,created) VALUES('crashed','claimed',?)`, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if err = reopened.Recover(); err != nil {
		t.Fatal(err)
	}
	if reopened.Run(context.Background(), fixtureJob("crashed")).State != "uncertain" || p.calls.Load() != 1 {
		t.Fatal("claimed crash replayed action")
	}
}
func TestDeadlineCancellationExpiryAndLocalPolicy(t *testing.T) {
	p := &fixturePlatform{block: true}
	e := engineFixture(t, p)
	j := fixtureJob("timeout")
	j.Deadline = time.Now().Add(10 * time.Millisecond).UnixMilli()
	if r := e.Run(context.Background(), j); r.State != "timed_out" {
		t.Fatalf("deadline outcome %s", r.State)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if r := e.Run(ctx, fixtureJob("cancel")); r.State != "cancelled" {
		t.Fatal("cancellation not propagated")
	}
	j = fixtureJob("expired")
	j.ExpiresAt = time.Now().Add(-time.Second).UnixMilli()
	if r := e.Run(context.Background(), j); r.State != "failed" || p.calls.Load() != 2 {
		t.Fatal("expired job executed")
	}
	j = fixtureJob("denied")
	j.Action = "service.restart"
	j.Args = core.Args{Service: "unapproved.service"}
	if r := e.Run(context.Background(), j); r.State != "failed" || p.calls.Load() != 2 {
		t.Fatal("local policy ignored")
	}
	j = fixtureJob("shell")
	j.Action = "shell"
	if r := e.Run(context.Background(), j); r.State != "failed" {
		t.Fatal("shell enabled")
	}
}
func TestOneExecutionSlotAndBoundedOutput(t *testing.T) {
	p := &fixturePlatform{block: true}
	e := engineFixture(t, p)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan core.Result, 1)
	go func() { done <- e.Run(ctx, fixtureJob("first")) }()
	until := time.Now().Add(time.Second)
	for p.calls.Load() == 0 && time.Now().Before(until) {
		time.Sleep(time.Millisecond)
	}
	if e.Run(context.Background(), fixtureJob("second")).State != "uncertain" || p.calls.Load() != 1 {
		t.Fatal("concurrency limit ignored")
	}
	cancel()
	<-done
	o := &output{}
	n, err := (stream{o, false}).Write([]byte(strings.Repeat("x", core.OutputLimit+100)))
	if err != nil || n != core.OutputLimit+100 || o.total != core.OutputLimit || !o.truncated {
		t.Fatal("stdout limit ignored")
	}
	_, _ = (stream{o, true}).Write([]byte("more"))
	if o.err.Len() != 0 {
		t.Fatal("combined stdout/stderr limit ignored")
	}
}
func TestRebootFixtureDoesNotRebootHost(t *testing.T) {
	p := &fixturePlatform{accepted: true}
	e := engineFixture(t, p)
	j := fixtureJob("reboot-fixture")
	j.Action = "host.reboot"
	j.Args = core.Args{}
	if e.Run(context.Background(), j).State != "accepted" {
		t.Fatal("missing acceptance")
	}
	_ = e.Run(context.Background(), j)
	if p.calls.Load() != 1 {
		t.Fatal("reboot fixture repeated")
	}
}
