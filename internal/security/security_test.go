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
