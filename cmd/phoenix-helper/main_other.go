//go:build !linux

package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "Phoenix privileged helper supports Linux/systemd only")
	os.Exit(1)
}
