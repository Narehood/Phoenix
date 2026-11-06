package server

import (
	"os"
	"path/filepath"
	"testing"
)

func TestInvalidConfigurationDoesNotLeavePartialIdentity(t *testing.T) {
	for _, origin := range []string{"http://localhost", "https://localhost/", "https://localhost?", "https://localhost#", "https://user@localhost", "https://localhost/path", "https://:8443"} {
		t.Run(origin, func(t *testing.T) {
			dir := t.TempDir()
			c := Config{DataDir: filepath.Join(dir, "data"), IdentityDir: filepath.Join(dir, "identity"), Origin: origin}
			if _, err := Init(c); err == nil {
				t.Fatal("initialization accepted invalid origin")
			}
			if _, err := New(c); err == nil {
				t.Fatal("startup accepted invalid origin")
			}
			entries, err := os.ReadDir(dir)
			if err != nil || len(entries) != 0 {
				t.Fatal("invalid configuration created retained state")
			}
			c.Origin = "https://localhost"
			if _, err := Init(c); err != nil {
				t.Fatalf("corrected configuration cannot initialize: %v", err)
			}
		})
	}
}

func TestConfigurationRequiresDirectoriesAndPairedTLSFiles(t *testing.T) {
	for _, c := range []Config{
		{Origin: "https://localhost", IdentityDir: "identity"},
		{Origin: "https://localhost", DataDir: "data"},
		{Origin: "https://localhost", DataDir: "data", IdentityDir: "identity", TLSCert: "cert"},
		{Origin: "https://localhost", DataDir: "data", IdentityDir: "identity", TLSKey: "key"},
	} {
		if err := validateConfig(c); err == nil {
			t.Fatal("accepted incomplete storage/TLS configuration")
		}
	}
}
