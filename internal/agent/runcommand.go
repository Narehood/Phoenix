package agent

import (
	"bytes"
	"context"
	"os/exec"
	"sync"
	"time"

	"github.com/Narehood/Phoenix/internal/core"
)

type output struct {
	mu        sync.Mutex
	out, err  bytes.Buffer
	total     int
	truncated bool
}
type stream struct {
	o      *output
	stderr bool
}

func (w stream) Write(p []byte) (int, error) {
	w.o.mu.Lock()
	defer w.o.mu.Unlock()
	n := len(p)
	remaining := core.OutputLimit - w.o.total
	if len(p) > remaining {
		p = p[:remaining]
		w.o.truncated = true
	}
	if w.stderr {
		w.o.err.Write(p)
	} else {
		w.o.out.Write(p)
	}
	w.o.total += len(p)
	return n, nil
}
func command(ctx context.Context, program string, args ...string) core.Result {
	started := time.Now().UnixMilli()
	o := &output{}
	cmd := exec.CommandContext(ctx, program, args...)
	cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C", "LC_ALL=C", "SYSTEMD_PAGER=cat", "SYSTEMD_COLORS=0"}
	cmd.Stdout = stream{o, false}
	cmd.Stderr = stream{o, true}
	cmd.WaitDelay = time.Second
	configureProcess(cmd)
	err := cmd.Run()
	r := core.Result{State: "succeeded", Stdout: o.out.String(), Stderr: o.err.String(), StartedAt: started, FinishedAt: time.Now().UnixMilli(), Truncated: o.truncated, ExitCode: 0}
	if err != nil {
		r.State = "failed"
		r.ExitCode = -1
		if cmd.ProcessState != nil {
			r.ExitCode = cmd.ProcessState.ExitCode()
		}
	}
	if ctx.Err() != nil {
		r.State = "timed_out"
		if ctx.Err() == context.Canceled {
			r.State = "cancelled"
		}
	}
	return r
}
