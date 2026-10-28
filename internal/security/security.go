package security

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"time"
)

func Token() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func Hash(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }
func WritePrivate(path string, b []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err = f.Write(b); err != nil {
		return err
	}
	return f.Sync()
}

type Vault struct{ aead cipher.AEAD }

func NewVault(key []byte) (*Vault, error) {
	if len(key) != 32 {
		return nil, errors.New("encryption key must be 32 bytes")
	}
	b, e := aes.NewCipher(key)
	if e != nil {
		return nil, e
	}
	a, e := cipher.NewGCM(b)
	return &Vault{a}, e
}
func (v *Vault) Seal(plain string, context string) string {
	n := make([]byte, v.aead.NonceSize())
	if _, e := rand.Read(n); e != nil {
		panic(e)
	}
	return base64.RawStdEncoding.EncodeToString(v.aead.Seal(n, n, []byte(plain), []byte(context)))
}
func (v *Vault) Open(sealed, context string) (string, error) {
	b, e := base64.RawStdEncoding.DecodeString(sealed)
	if e != nil || len(b) < v.aead.NonceSize() {
		return "", errors.New("invalid encrypted value")
	}
	n := v.aead.NonceSize()
	p, e := v.aead.Open(nil, b[:n], b[n:], []byte(context))
	return string(p), e
}

type CA struct {
	Certificate *x509.Certificate
	Key         ed25519.PrivateKey
	PEM         []byte
}

func NewCA() (*CA, error) {
	pub, key, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		return nil, e
	}
	serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	t := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "Phoenix agent CA"}, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().AddDate(5, 0, 0), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign}
	der, e := x509.CreateCertificate(rand.Reader, t, t, pub, key)
	if e != nil {
		return nil, e
	}
	cert, e := x509.ParseCertificate(der)
	return &CA{cert, key, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})}, e
}
func LoadCA(dir string) (*CA, error) {
	b, e := os.ReadFile(filepath.Join(dir, "ca.pem"))
	if e != nil {
		return nil, e
	}
	block, _ := pem.Decode(b)
	if block == nil {
		return nil, errors.New("invalid CA")
	}
	cert, e := x509.ParseCertificate(block.Bytes)
	if e != nil {
		return nil, e
	}
	k, e := os.ReadFile(filepath.Join(dir, "ca.key"))
	if e != nil {
		return nil, e
	}
	block, _ = pem.Decode(k)
	if block == nil {
		return nil, errors.New("invalid CA key")
	}
	key, e := x509.ParsePKCS8PrivateKey(block.Bytes)
	if e != nil {
		return nil, e
	}
	ed, ok := key.(ed25519.PrivateKey)
	if !ok {
		return nil, errors.New("CA key must be Ed25519")
	}
	if !cert.PublicKey.(ed25519.PublicKey).Equal(ed.Public()) {
		return nil, errors.New("CA key mismatch")
	}
	return &CA{cert, ed, b}, nil
}
func (c *CA) Save(dir string) error {
	if e := os.MkdirAll(dir, 0700); e != nil {
		return e
	}
	key, e := x509.MarshalPKCS8PrivateKey(c.Key)
	if e != nil {
		return e
	}
	if e = WritePrivate(filepath.Join(dir, "ca.key"), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key})); e != nil {
		return e
	}
	return WritePrivate(filepath.Join(dir, "ca.pem"), c.PEM)
}
func NewCSR() (string, []byte, error) {
	_, key, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		return "", nil, e
	}
	der, e := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{}, key)
	if e != nil {
		return "", nil, e
	}
	k, e := x509.MarshalPKCS8PrivateKey(key)
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der})), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: k}), e
}
func (c *CA) Sign(csrPEM, host string, ttl time.Duration) (certPEM, serial string, expiry int64, err error) {
	return c.signAt(csrPEM, host, ttl, time.Now())
}

func (c *CA) signAt(csrPEM, host string, ttl time.Duration, now time.Time) (certPEM, serial string, expiry int64, err error) {
	// X.509 validity is encoded in whole seconds. Capture a single issuance
	// instant so an exact one-hour lifetime remains valid at the boundary.
	now = now.UTC().Truncate(time.Second)
	b, _ := pem.Decode([]byte(csrPEM))
	if b == nil {
		return "", "", 0, errors.New("invalid CSR")
	}
	csr, e := x509.ParseCertificateRequest(b.Bytes)
	if e != nil || csr.CheckSignature() != nil {
		return "", "", 0, errors.New("invalid signed CSR")
	}
	if _, ok := csr.PublicKey.(ed25519.PublicKey); !ok {
		return "", "", 0, errors.New("agent key must be Ed25519")
	}
	n, e := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if e != nil {
		return "", "", 0, e
	}
	uri, _ := url.Parse("spiffe://phoenix/host/" + host)
	expires := now.Add(ttl)
	if expires.After(c.Certificate.NotAfter) {
		expires = c.Certificate.NotAfter
	}
	expires = expires.Truncate(time.Second)
	if expires.Before(now.Add(time.Hour)) {
		return "", "", 0, errors.New("certificate validity window is shorter than one hour")
	}
	t := &x509.Certificate{SerialNumber: n, Subject: pkix.Name{CommonName: host}, URIs: []*url.URL{uri}, NotBefore: now.Add(-time.Minute), NotAfter: expires, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}
	der, e := x509.CreateCertificate(rand.Reader, t, c.Certificate, csr.PublicKey, c.Key)
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), n.String(), expires.UnixMilli(), e
}
func (c *CA) ServerCertificate(names []string) ([]byte, []byte, error) {
	pub, key, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		return nil, nil, e
	}
	n, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	t := &x509.Certificate{SerialNumber: n, Subject: pkix.Name{CommonName: "Phoenix"}, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().AddDate(1, 0, 0), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	for _, s := range names {
		if ip := net.ParseIP(s); ip != nil {
			t.IPAddresses = append(t.IPAddresses, ip)
		} else {
			t.DNSNames = append(t.DNSNames, s)
		}
	}
	der, e := x509.CreateCertificate(rand.Reader, t, c.Certificate, pub, c.Key)
	if e != nil {
		return nil, nil, e
	}
	k, e := x509.MarshalPKCS8PrivateKey(key)
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: k}), e
}

// Pins supplement normal chain and hostname verification, including private CAs.
func ClientTLS(caPEM []byte, pin string) (*tls.Config, error) {
	roots, e := x509.SystemCertPool()
	if e != nil {
		roots = x509.NewCertPool()
	}
	if len(caPEM) > 0 && !roots.AppendCertsFromPEM(caPEM) {
		return nil, errors.New("invalid trust bundle")
	}
	t := &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: roots}
	if pin != "" {
		if len(pin) != 64 {
			return nil, errors.New("pin must be SHA256 lowercase hex")
		}
		if _, e := hex.DecodeString(pin); e != nil {
			return nil, e
		}
		t.VerifyConnection = func(s tls.ConnectionState) error {
			if len(s.PeerCertificates) == 0 || HashBytes(s.PeerCertificates[0].Raw) != pin {
				return errors.New("certificate pin mismatch")
			}
			return nil
		}
	}
	return t, nil
}
func HashBytes(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
