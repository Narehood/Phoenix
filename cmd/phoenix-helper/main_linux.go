//go:build linux

// This binary is invoked only through an exact-path sudoers rule. It never
// listens on the network, accepts shell text or permits a caller-supplied config.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"syscall"
	"time"

	"github.com/Narehood/Phoenix/internal/core"
	"golang.org/x/sys/unix"
)

type policy struct {
	RestartServices []string `json:"restartServices"`
	AllowReboot     bool     `json:"allowReboot"`
}

var unit = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.@-]{0,100}\.service$`)

func main() {
	if os.Geteuid() != 0 {
		deny()
	}
	p, e := readPolicy("/etc/phoenix/helper.json", 0)
	if e != nil {
		deny()
	}
	args, deadline, e := request(p, os.Args[1:], time.Now())
	if e != nil {
		deny()
	}
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/usr/bin/systemctl", args...)
	cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C", "SYSTEMD_PAGER=cat"}
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	err := cmd.Run()
	if ctx.Err() != nil {
		os.Exit(core.HelperTimeoutExitCode)
	}
	if err != nil {
		os.Exit(1)
	}
}

func readPolicy(path string, owner uint32) (policy, error) {
	var p policy
	// Verify the opened file itself; a path check followed by ReadFile races
	// replacement and reads an arbitrarily large policy before enforcing its cap.
	fd, e := unix.Open(path, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if e != nil {
		return p, e
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	info, e := f.Stat()
	if e != nil {
		return p, e
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.Mode().IsRegular() || info.Mode().Perm()&0022 != 0 || !ok || stat.Uid != owner {
		return p, errors.New("untrusted helper policy")
	}
	b, e := io.ReadAll(io.LimitReader(f, 8193))
	if e != nil || len(b) > 8192 {
		return p, errors.New("helper policy read limit")
	}
	e = json.Unmarshal(b, &p)
	return p, e
}

func request(p policy, input []string, now time.Time) ([]string, time.Time, error) {
	var args []string
	var expiry string
	if len(input) == 3 && input[0] == "restart" && unit.MatchString(input[1]) {
		for _, s := range p.RestartServices {
			if s == input[1] {
				args = []string{"restart", "--", s}
				expiry = input[2]
			}
		}
	} else if len(input) == 2 && input[0] == "reboot" && p.AllowReboot {
		args = []string{"reboot"}
		expiry = input[1]
	}
	if len(args) == 0 {
		return nil, time.Time{}, errors.New("action refused")
	}
	ms, e := strconv.ParseInt(expiry, 10, 64)
	if e != nil || ms <= now.UnixMilli() {
		return nil, time.Time{}, errors.New("deadline refused")
	}
	deadline := time.UnixMilli(ms)
	if max := now.Add(25 * time.Second); deadline.After(max) {
		deadline = max
	}
	return args, deadline, nil
}
func deny() { fmt.Fprintln(os.Stderr, "Phoenix helper policy refused request"); os.Exit(1) }
