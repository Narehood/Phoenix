//go:build linux

package main

import (
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// These fixtures never enter main or invoke systemctl/sudo.
func TestHelperPolicyFileBoundary(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "policy.json")
	valid := []byte(`{"restartServices":["fixture.service"],"allowReboot":false}`)
	if err := os.WriteFile(path, valid, 0600); err != nil {
		t.Fatal(err)
	}
	owner := uint32(os.Geteuid())
	p, err := readPolicy(path, owner)
	if err != nil || len(p.RestartServices) != 1 || p.AllowReboot {
		t.Fatal("valid private policy refused")
	}
	if _, err := readPolicy(path, owner+1); err == nil {
		t.Fatal("wrong policy owner accepted")
	}
	if err := os.Chmod(path, 0666); err != nil {
		t.Fatal(err)
	}
	if _, err := readPolicy(path, owner); err == nil {
		t.Fatal("writable policy accepted")
	}
	if err := os.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{strings.Repeat(" ", 8193), `{"allowReboot":true} trailing`} {
		if err := os.WriteFile(path, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := readPolicy(path, owner); err == nil {
			t.Fatal("oversized or malformed policy accepted")
		}
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if _, err := readPolicy(link, owner); err == nil {
		t.Fatal("policy symlink accepted")
	}
	fifo := filepath.Join(dir, "fifo")
	if err := unix.Mkfifo(fifo, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readPolicy(fifo, owner); err == nil {
		t.Fatal("non-regular policy accepted")
	}
}

func TestHelperTypedActionsAndDeadlines(t *testing.T) {
	now := time.Unix(1800000000, 0)
	deadline := strconv.FormatInt(now.Add(time.Minute).UnixMilli(), 10)
	p := policy{RestartServices: []string{"fixture.service"}}
	args, until, err := request(p, []string{"restart", "fixture.service", deadline}, now)
	if err != nil || !reflect.DeepEqual(args, []string{"restart", "--", "fixture.service"}) || !until.Equal(now.Add(25*time.Second)) {
		t.Fatal("allowlisted restart or deadline cap incorrect")
	}
	near := now.Add(time.Second)
	_, until, err = request(p, []string{"restart", "fixture.service", strconv.FormatInt(near.UnixMilli(), 10)}, now)
	if err != nil || !until.Equal(near) {
		t.Fatal("short deadline extended")
	}
	for _, input := range [][]string{
		nil, {"restart"}, {"restart", "other.service", deadline},
		{"restart", "fixture.service;reboot", deadline}, {"restart", "--help", deadline},
		{"restart", "../fixture.service", deadline}, {"restart", "fixture.service", deadline, "extra"},
		{"restart", "fixture.service", "invalid"}, {"restart", "fixture.service", strconv.FormatInt(now.UnixMilli(), 10)},
		{"restart", "fixture.service", "-1"}, {"reboot", deadline}, {"shell", deadline},
	} {
		if _, _, err := request(p, input, now); err == nil {
			t.Fatalf("accepted forbidden request %q", input)
		}
	}
	p.AllowReboot = true
	args, _, err = request(p, []string{"reboot", deadline}, now)
	if err != nil || !reflect.DeepEqual(args, []string{"reboot"}) {
		t.Fatal("explicitly enabled reboot policy not recognized")
	}
}
