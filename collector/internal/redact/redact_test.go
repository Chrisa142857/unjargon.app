package redact

import (
	"strings"
	"testing"
)

func TestClean(t *testing.T) {
	cases := []struct {
		name, in   string
		mustGo     []string // substrings that must NOT survive
		mustRemain []string // substrings that must survive
	}{
		{
			name:   "anthropic key",
			in:     "set ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop1234 in your env",
			mustGo: []string{"sk-ant-api03-abcdefghijklmnop1234"},
		},
		{
			name:   "github pat",
			in:     "using ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 for auth",
			mustGo: []string{"ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"},
		},
		{
			name:   "aws + bearer",
			in:     "creds AKIAIOSFODNN7EXAMPLE and header Authorization: Bearer abcdef0123456789abcdef",
			mustGo: []string{"AKIAIOSFODNN7EXAMPLE", "abcdef0123456789abcdef"},
		},
		{
			name:   "jwt",
			in:     "token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U ok",
			mustGo: []string{"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"},
		},
		{
			name: "env blob refused",
			in: "here is your config:\nDATABASE_URL=postgres://u:p@h/db\nSECRET_KEY=abc12345\nSTRIPE_KEY=sk_live_xyz\ndone",
			mustGo:     []string{"postgres://u:p@h/db", "sk_live_xyz"},
			mustRemain: []string{"here is your config:", "done", "[redacted .env-like block]"},
		},
		{
			name: "pem block",
			in:   "key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\nend",
			mustGo:     []string{"MIIEowIBAAKCAQEA"},
			mustRemain: []string{"end"},
		},
		{
			name:       "normal text untouched",
			in:         "All 12 regression tests pass; run finished in 3.1s vs 127.4s (40× faster). See sim/solver.py:12.",
			mustRemain: []string{"All 12 regression tests pass; run finished in 3.1s vs 127.4s (40× faster). See sim/solver.py:12."},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Clean(c.in)
			for _, s := range c.mustGo {
				if strings.Contains(got, s) {
					t.Errorf("secret survived: %q in %q", s, got)
				}
			}
			for _, s := range c.mustRemain {
				if !strings.Contains(got, s) {
					t.Errorf("lost %q in %q", s, got)
				}
			}
		})
	}
}
