package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"github.com/Narehood/Phoenix/internal/server"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "Usage: phoenix init|serve|setup-renew|recover-admin -config /etc/phoenix/server.json [-account name]")
		os.Exit(2)
	}
	flags := flag.NewFlagSet("phoenix", flag.ExitOnError)
	path := flags.String("config", "/etc/phoenix/server.json", "server configuration JSON (no .env loading)")
	account := flags.String("account", "", "administrator name for offline recovery")
	_ = flags.Parse(os.Args[2:])
	b, e := os.ReadFile(*path)
	if e != nil {
		die("Cannot read server configuration")
	}
	var c server.Config
	if json.Unmarshal(b, &c) != nil {
		die("Invalid server configuration")
	}
	switch os.Args[1] {
	case "setup-renew":
		path, e := server.RenewBootstrap(c)
		if e != nil {
			die("Bootstrap renewal failed; stop the server and inspect setup state")
		}
		fmt.Println("Bootstrap token written to private file:", path)
	case "recover-admin":
		path, e := server.RecoverAdmin(c, *account)
		if e != nil {
			die("Offline recovery failed; stop the server and inspect identity/account state")
		}
		fmt.Println("Recovery credentials written to private file:", path)
	case "init":
		path, e := server.Init(c)
		if e != nil {
			die("Initialization failed; inspect configuration and retained identity before retrying")
		}
		fmt.Println("Bootstrap token written to private file:", path)
	case "serve":
		s, e := server.New(c)
		if e != nil {
			die("Server initialization failed")
		}
		defer s.DB.Close()
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		if e = s.Serve(ctx); e != nil {
			die("Server stopped: configuration, listener or identity error")
		}
	default:
		die("Unknown command")
	}
}
func die(message string) { fmt.Fprintln(os.Stderr, message); os.Exit(1) }
