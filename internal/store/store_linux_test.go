//go:build linux

package store

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestDatabaseAndSidecarsArePrivateBeforeFirstWrite(t *testing.T) {
	// This changes only the isolated fixture process, never the developer host.
	previous := syscall.Umask(0022)
	defer syscall.Umask(previous)
	for _, existing := range []bool{false, true} {
		name := "new file"
		if existing {
			name = "existing public empty file"
		}
		t.Run(name, func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), "public-directory")
			if err := os.Mkdir(dir, 0755); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(dir, "fixture.db")
			if existing {
				if err := os.WriteFile(path, nil, 0644); err != nil {
					t.Fatal(err)
				}
			}
			db, err := Open(path)
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			for _, file := range []string{path, path + "-wal", path + "-shm"} {
				info, err := os.Stat(file)
				if err != nil {
					t.Fatal(err)
				}
				if info.Mode().Perm()&0077 != 0 {
					t.Fatalf("fixture database file %s exposes mode %o", filepath.Base(file), info.Mode().Perm())
				}
			}
		})
	}
}
