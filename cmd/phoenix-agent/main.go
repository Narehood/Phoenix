package main

import (
	"context"
	"encoding/json"
	"encoding/pem"
	"flag"
	"fmt"
	"github.com/Narehood/Phoenix/internal/agent"
	"github.com/Narehood/Phoenix/internal/security"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "Usage: phoenix-agent enroll|identity|run -config /etc/phoenix/agent.json [-invitation-file private-file]")
		os.Exit(2)
	}
	f := flag.NewFlagSet("agent", flag.ExitOnError)
	path := f.String("config", "/etc/phoenix/agent.json", "agent configuration")
	inv := f.String("invitation-file", "", "private single-use invitation file")
	_ = f.Parse(os.Args[2:])
	b, e := os.ReadFile(*path)
	if e != nil {
		die("Cannot read agent configuration")
	}
	var c agent.Config
	if json.Unmarshal(b, &c) != nil {
		die("Invalid agent configuration")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	switch os.Args[1] {
	case "identity":
		bundle, e := agent.LoadBundle(c.StateDir)
		if e != nil {
			die("Cannot read enrolled identity")
		}
		block, _ := pem.Decode([]byte(bundle.Identity.Certificate))
		if block == nil {
			die("Invalid enrolled certificate")
		}
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"hostId": bundle.Identity.HostID, "certificateFingerprint": security.HashBytes(block.Bytes), "expiresAt": bundle.Identity.ExpiresAt})
	case "enroll":
		if e = agent.Enroll(ctx, c, *inv); e != nil {
			die("Enrollment failed: check server trust, invitation and retained identity")
		}
		fmt.Println("Agent enrolled; start the agent service.")
	case "run":
		if e = agent.Run(ctx, c); e != nil {
			die(e.Error())
		}
	default:
		die("Unknown command")
	}
}
func die(s string) { fmt.Fprintln(os.Stderr, s); os.Exit(1) }
