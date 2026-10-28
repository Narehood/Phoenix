package security

import (
	"crypto/x509"
	"encoding/pem"
	"strings"
	"testing"
	"time"
)

func TestVaultContextAndCertificateIdentity(t *testing.T) {
	v, e := NewVault(make([]byte, 32))
	if e != nil {
		t.Fatal(e)
	}
	ciphertext := v.Seal("fixture secret", "canary:a")
	if strings.Contains(ciphertext, "fixture secret") {
		t.Fatal("plaintext stored")
	}
	if _, e = v.Open(ciphertext, "canary:b"); e == nil {
		t.Fatal("encrypted secret moved between identities")
	}
	if value, e := v.Open(ciphertext, "canary:a"); e != nil || value != "fixture secret" {
		t.Fatal("vault roundtrip failed")
	}
	ca, e := NewCA()
	if e != nil {
		t.Fatal(e)
	}
	csr, _, e := NewCSR()
	if e != nil {
		t.Fatal(e)
	}
	cert, _, expiry, e := ca.Sign(csr, "fixture-host", time.Hour)
	if e != nil {
		t.Fatal(e)
	}
	block, _ := pem.Decode([]byte(cert))
	parsed, e := x509.ParseCertificate(block.Bytes)
	if e != nil {
		t.Fatal(e)
	}
	if parsed.Subject.CommonName != "fixture-host" || parsed.URIs[0].String() != "spiffe://phoenix/host/fixture-host" || expiry <= time.Now().UnixMilli() {
		t.Fatal("certificate host/expiry binding invalid")
	}
	if _, _, _, e = ca.Sign("not a CSR", "fixture-host", time.Hour); e == nil {
		t.Fatal("unsigned CSR accepted")
	}
}

func TestCertificateValidityBoundaries(t *testing.T) {
	ca, err := NewCA()
	if err != nil {
		t.Fatal(err)
	}
	csr, _, err := NewCSR()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2030, time.January, 2, 3, 4, 5, 987654321, time.UTC)
	issued := now.Truncate(time.Second)
	for _, tc := range []struct {
		name         string
		ttl          time.Duration
		caRemaining  time.Duration
		wantLifetime time.Duration
		wantError    bool
	}{
		{"exact one hour", time.Hour, 24 * time.Hour, time.Hour, false},
		{"issuer expires in exactly one hour", 24 * time.Hour, time.Hour, time.Hour, false},
		{"clipped to issuer expiry", 24 * time.Hour, 2 * time.Hour, 2 * time.Hour, false},
		{"issuer has less than one hour", 24 * time.Hour, time.Hour - time.Second, 0, true},
		{"requested lifetime below minimum", time.Hour - time.Nanosecond, 24 * time.Hour, 0, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			issuer := *ca.Certificate
			issuer.NotBefore = issued.Add(-time.Hour)
			issuer.NotAfter = issued.Add(tc.caRemaining)
			bounded := *ca
			bounded.Certificate = &issuer
			encoded, _, expiry, err := bounded.signAt(csr, "fixture-host", tc.ttl, now)
			if tc.wantError {
				if err == nil {
					t.Fatal("accepted a validity window below the minimum")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			block, _ := pem.Decode([]byte(encoded))
			if block == nil {
				t.Fatal("invalid certificate encoding")
			}
			cert, err := x509.ParseCertificate(block.Bytes)
			if err != nil {
				t.Fatal(err)
			}
			if !cert.NotAfter.Equal(issued.Add(tc.wantLifetime)) || expiry != cert.NotAfter.UnixMilli() {
				t.Fatal("reported expiry differs from the encoded certificate validity")
			}
			if !cert.NotBefore.Equal(issued.Add(-time.Minute)) || cert.NotAfter.After(issuer.NotAfter) {
				t.Fatal("certificate validity exceeds its issuance/issuer bounds")
			}
		})
	}
}

func TestClientTLSPinSyntax(t *testing.T) {
	for _, pin := range []string{strings.Repeat("A", 64), strings.Repeat("g", 64), "short"} {
		if _, err := ClientTLS(nil, pin); err == nil {
			t.Fatal("invalid pin passed configuration validation")
		}
	}
	if _, err := ClientTLS(nil, strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
}
