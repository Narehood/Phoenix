//go:build linux

package agent

import (
	"testing"

	"github.com/Narehood/Phoenix/internal/core"
)

func TestHelperTimeoutIsAnUncertainAdministrativeOutcome(t *testing.T) {
	for _, tc := range []struct {
		name   string
		result core.Result
		want   string
	}{
		{"helper deadline before agent deadline", core.Result{State: "failed", ExitCode: core.HelperTimeoutExitCode}, "uncertain"},
		{"agent deadline", core.Result{State: "timed_out", ExitCode: -1}, "uncertain"},
		{"agent cancellation", core.Result{State: "cancelled", ExitCode: -1}, "uncertain"},
		{"policy refusal", core.Result{State: "failed", ExitCode: 1}, "failed"},
		{"completed", core.Result{State: "succeeded", ExitCode: 0}, "succeeded"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := helperResult(tc.result); got.State != tc.want || got.ExitCode != tc.result.ExitCode {
				t.Fatalf("helper outcome %+v, want state %s with original exit code", got, tc.want)
			}
		})
	}
}
