//go:build linux

// This binary is invoked only through an exact-path sudoers rule. It never
// listens on the network, accepts shell text or permits a caller-supplied config.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"syscall"
	"time"
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
	path := "/etc/phoenix/helper.json"
	info, e := os.Lstat(path)
	if e != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0022 != 0 {
		deny()
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != 0 {
		deny()
	}
	b, e := os.ReadFile(path)
	if e != nil || len(b) > 8192 {
		deny()
	}
	var p policy
	if json.Unmarshal(b, &p) != nil {
		deny()
	}
	var args []string
	var expiry string
	if len(os.Args) == 4 && os.Args[1] == "restart" && unit.MatchString(os.Args[2]) {
		for _, s := range p.RestartServices {
			if s == os.Args[2] {
				args = []string{"restart", "--", s}
				expiry = os.Args[3]
			}
		}
	} else if len(os.Args) == 3 && os.Args[1] == "reboot" && p.AllowReboot {
		args = []string{"reboot"}
		expiry = os.Args[2]
	}
	if len(args) == 0 {
		deny()
	}
	ms, e := strconv.ParseInt(expiry, 10, 64)
	if e != nil || ms <= time.Now().UnixMilli() {
		deny()
	}
	deadline := time.UnixMilli(ms)
	if max := time.Now().Add(25 * time.Second); deadline.After(max) {
		deadline = max
	}
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/usr/bin/systemctl", args...)
	cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C", "SYSTEMD_PAGER=cat"}
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if cmd.Run() != nil {
		os.Exit(1)
	}
}
func deny() { fmt.Fprintln(os.Stderr, "Phoenix helper policy refused request"); os.Exit(1) }
