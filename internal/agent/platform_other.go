//go:build !linux

package agent

import (
	"context"
	"errors"
	"github.com/Narehood/Phoenix/internal/core"
	"os/exec"
)

func configureProcess(cmd *exec.Cmd)   {}
func lockState(string) (func(), error) { return nil, errors.New("unsupported platform") }

type Linux struct{ Policy Policy }

func NewLinux(p Policy) (*Linux, error) {
	return nil, errors.New("Linux/systemd agent is not implemented on this platform")
}
func (l *Linux) Collect(context.Context) (core.Reading, error) {
	return core.Reading{}, errors.New("unsupported platform")
}
func (l *Linux) Execute(context.Context, core.Job) core.Result {
	return core.Result{State: "failed", ExitCode: -1, Stderr: "Unsupported platform"}
}
func Metadata() (string, string, []string, error) {
	return "", "", nil, errors.New("unsupported platform")
}
