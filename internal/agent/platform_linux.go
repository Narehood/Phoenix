//go:build linux

package agent

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Narehood/Phoenix/internal/core"
	"golang.org/x/sys/unix"
)

type Linux struct {
	Policy              Policy
	mu                  sync.Mutex
	lastTotal, lastIdle uint64
	lastRX, lastTX      uint64
	lastMeasured        int64
	lastBoot            string
}

func NewLinux(p Policy) (*Linux, error) {
	if os.Geteuid() == 0 {
		return nil, errors.New("network-facing agent must run without root")
	}
	return &Linux{Policy: p}, nil
}
func smallFile(path string) (string, error) {
	f, e := os.Open(path)
	if e != nil {
		return "", e
	}
	defer f.Close()
	b, e := io.ReadAll(io.LimitReader(f, 16384))
	return string(b), e
}
func Metadata() (string, string, []string, error) {
	release, e := smallFile("/etc/os-release")
	if e != nil {
		return "", "", nil, e
	}
	version := "Linux"
	for _, line := range strings.Split(release, "\n") {
		if strings.HasPrefix(line, "PRETTY_NAME=") {
			version = strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), "\"")
		}
	}
	addrs, e := net.InterfaceAddrs()
	if e != nil {
		return "", "", nil, e
	}
	addresses := []string{}
	for _, a := range addrs {
		ip, _, e := net.ParseCIDR(a.String())
		if e == nil && !ip.IsLoopback() && len(addresses) < 16 {
			addresses = append(addresses, ip.String())
		}
	}
	return "linux", version, addresses, nil
}
func (l *Linux) Collect(ctx context.Context) (core.Reading, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	r := core.Reading{MeasuredAt: time.Now().UnixMilli(), Processes: []core.Process{}, Services: []core.Service{}, CollectionErrors: []string{}}
	record := func(msg string, e error) {
		if e != nil && len(r.CollectionErrors) < 10 {
			r.CollectionErrors = append(r.CollectionErrors, msg)
		}
	}
	stat, e := smallFile("/proc/stat")
	record("CPU unavailable", e)
	if e == nil {
		line := strings.SplitN(stat, "\n", 2)[0]
		fields := strings.Fields(line)
		if len(fields) >= 5 {
			var total, idle uint64
			for i, v := range fields[1:] {
				if i >= 8 {
					break
				}
				n, _ := strconv.ParseUint(v, 10, 64)
				total += n
				if i == 3 || i == 4 {
					idle += n
				}
			}
			if l.lastTotal > 0 && total > l.lastTotal && idle >= l.lastIdle {
				v := 100 * (1 - float64(idle-l.lastIdle)/float64(total-l.lastTotal))
				r.CPUPercent = &v
			}
			l.lastTotal = total
			l.lastIdle = idle
		}
	}
	mem, e := smallFile("/proc/meminfo")
	record("Memory unavailable", e)
	var available uint64
	for _, line := range strings.Split(mem, "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		v, _ := strconv.ParseUint(f[1], 10, 64)
		if f[0] == "MemTotal:" {
			r.MemoryTotal = v * 1024
		}
		if f[0] == "MemAvailable:" {
			available = v * 1024
		}
	}
	if available <= r.MemoryTotal {
		r.MemoryUsed = r.MemoryTotal - available
	}
	var disk unix.Statfs_t
	e = unix.Statfs("/", &disk)
	record("Root filesystem unavailable", e)
	if e == nil {
		r.DiskTotal = disk.Blocks * uint64(disk.Bsize)
		r.DiskUsed = (disk.Blocks - disk.Bfree) * uint64(disk.Bsize)
	}
	network, e := smallFile("/proc/net/dev")
	record("Network counters unavailable", e)
	for _, line := range strings.Split(network, "\n") {
		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 || strings.TrimSpace(parts[0]) == "lo" {
			continue
		}
		f := strings.Fields(parts[1])
		if len(f) >= 16 {
			rx, _ := strconv.ParseUint(f[0], 10, 64)
			tx, _ := strconv.ParseUint(f[8], 10, 64)
			r.NetworkRX += rx
			r.NetworkTX += tx
		}
	}
	uptime, e := smallFile("/proc/uptime")
	record("Uptime unavailable", e)
	_, _ = fmt.Sscan(uptime, &r.UptimeSeconds)
	boot, e := smallFile("/proc/sys/kernel/random/boot_id")
	record("Boot identity unavailable", e)
	r.BootID = strings.TrimSpace(boot)
	if l.lastMeasured > 0 && r.MeasuredAt > l.lastMeasured && r.BootID == l.lastBoot && r.NetworkRX >= l.lastRX && r.NetworkTX >= l.lastTX {
		seconds := float64(r.MeasuredAt-l.lastMeasured) / 1000
		rx, tx := float64(r.NetworkRX-l.lastRX)/seconds, float64(r.NetworkTX-l.lastTX)/seconds
		r.NetworkRXBPS, r.NetworkTXBPS = &rx, &tx
	}
	l.lastRX, l.lastTX, l.lastMeasured, l.lastBoot = r.NetworkRX, r.NetworkTX, r.MeasuredAt, r.BootID
	dir, e := os.Open("/proc")
	record("Process list unavailable", e)
	if e == nil {
		entries, _ := dir.ReadDir(4096)
		_ = dir.Close()
		for _, entry := range entries {
			pid, e := strconv.Atoi(entry.Name())
			if e != nil {
				continue
			}
			name, e := smallFile(filepath.Join("/proc", entry.Name(), "comm"))
			if e != nil {
				continue
			}
			status, _ := smallFile(filepath.Join("/proc", entry.Name(), "statm"))
			var pages, resident uint64
			_, _ = fmt.Sscan(status, &pages, &resident)
			r.Processes = append(r.Processes, core.Process{PID: pid, Name: truncate(strings.TrimSpace(name), 128), MemoryBytes: resident * uint64(os.Getpagesize())})
		}
		sort.Slice(r.Processes, func(i, j int) bool { return r.Processes[i].MemoryBytes > r.Processes[j].MemoryBytes })
		if len(r.Processes) > 100 {
			r.Processes = r.Processes[:100]
		}
	}
	bounded, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	services := command(bounded, "/usr/bin/systemctl", "list-units", "--all", "--type=service", "--no-legend", "--no-pager", "--plain")
	if services.State != "succeeded" {
		record("systemd inspection unavailable", errors.New("systemctl failed"))
	} else {
		for _, line := range strings.Split(services.Stdout, "\n") {
			f := strings.Fields(line)
			if len(f) >= 4 && len(r.Services) < 100 {
				r.Services = append(r.Services, core.Service{Name: truncate(f[0], 128), Load: truncate(f[1], 32), Active: truncate(f[2], 32), Sub: truncate(f[3], 32)})
			}
		}
	}
	return r, nil
}
func (l *Linux) Execute(ctx context.Context, j core.Job) core.Result {
	if !l.Policy.Allows(j) {
		return core.Result{State: "failed", ExitCode: -1, Stderr: "Local policy refused action"}
	}
	deadline := strconv.FormatInt(j.Deadline, 10)
	switch j.Action {
	case "diagnostic":
		return command(ctx, "/usr/bin/uname", "-a")
	case "services.inspect":
		return command(ctx, "/usr/bin/systemctl", "list-units", "--all", "--type=service", "--no-legend", "--no-pager", "--plain")
	case "logs.read":
		return command(ctx, "/usr/bin/journalctl", "--unit", j.Args.Service, "--lines=200", "--no-pager", "--output=short-iso", "--quiet")
	case "service.restart":
		return helperResult(command(ctx, "/usr/bin/sudo", "-n", "/usr/local/libexec/phoenix-helper", "restart", j.Args.Service, deadline))
	case "host.reboot":
		r := helperResult(command(ctx, "/usr/bin/sudo", "-n", "/usr/local/libexec/phoenix-helper", "reboot", deadline))
		if r.State == "succeeded" {
			r.State = "accepted"
		}
		return r
	}
	return core.Result{State: "failed", ExitCode: -1, Stderr: "Unsupported action"}
}

func helperResult(r core.Result) core.Result {
	if r.State == "timed_out" || r.State == "cancelled" || r.ExitCode == core.HelperTimeoutExitCode {
		r.State = "uncertain"
	}
	return r
}
