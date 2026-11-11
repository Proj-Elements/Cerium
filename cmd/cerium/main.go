package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"cerium"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:], os.Stdin, os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "cerium:", err)
		os.Exit(1)
	}
}

const usage = `cerium - one-shot Sub2API / NewAPI catalog synchronizer

Commands:
  import  -config credentials.json   Import credentials into SQLite (no network)
  run     [-webhook URL]             Synchronize each stored credential once
  serve   [-listen 127.0.0.1:8091]    Signed bridge for the separate Node service
  list                              List credentials without passwords/tokens
  show                              Show last attempts and last good snapshots
  remove  -id ID                     Delete a credential and its local data

All commands accept -db PATH (default: data/cerium.db).
run accepts -request-timeout 20s and -site-timeout 2m.
With no command, run is used. Configuration may be read from stdin with -config -.
Optional webhook environment: CERIUM_WEBHOOK_URL, CERIUM_WEBHOOK_SECRET.
`

func run(ctx context.Context, args []string, in io.Reader, out, stderr io.Writer) error {
	command := "run"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		command, args = args[0], args[1:]
	}
	if command == "help" {
		_, err := io.WriteString(out, usage)
		return err
	}
	if command != "import" && command != "run" && command != "list" && command != "show" && command != "remove" && command != "serve" {
		return errors.New("unknown command; use cerium help")
	}
	flags := flag.NewFlagSet("cerium "+command, flag.ContinueOnError)
	flags.SetOutput(stderr)
	flags.Usage = func() { fmt.Fprint(stderr, usage); flags.PrintDefaults() }
	dbPath := flags.String("db", "data/cerium.db", "SQLite database file")
	var config, webhook, listen string
	var id int64
	var requestTimeout, siteTimeout time.Duration
	switch command {
	case "serve":
		flags.StringVar(&listen, "listen", "127.0.0.1:8091", "bridge bind address")
		flags.StringVar(&webhook, "webhook", "", "Node result webhook URL (or CERIUM_WEBHOOK_URL)")
	case "import":
		flags.StringVar(&config, "config", "credentials.json", "credentials JSON file, or - for stdin")
	case "run":
		flags.StringVar(&webhook, "webhook", "", "optional result webhook URL (or CERIUM_WEBHOOK_URL)")
		flags.DurationVar(&requestTimeout, "request-timeout", 20*time.Second, "timeout per HTTP request")
		flags.DurationVar(&siteTimeout, "site-timeout", 2*time.Minute, "total timeout per credential")
	case "remove":
		flags.Int64Var(&id, "id", 0, "credential ID to remove")
	}
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return errors.New("invalid command flags; use cerium help")
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected positional arguments; use command flags")
	}
	if command == "run" && (requestTimeout <= 0 || siteTimeout <= 0) {
		return errors.New("timeouts must be positive")
	}
	if (command == "run" || command == "serve") && webhook == "" {
		webhook = os.Getenv("CERIUM_WEBHOOK_URL")
	}
	if command == "remove" && id <= 0 {
		return errors.New("remove requires a positive -id")
	}
	store, err := cerium.OpenStore(*dbPath)
	if err != nil {
		return err
	}
	defer store.Close()
	encoder := json.NewEncoder(out)
	encoder.SetIndent("", "  ")
	switch command {
	case "serve":
		secret := os.Getenv("CERIUM_WEBHOOK_SECRET")
		sink, err := cerium.NewWebhook(webhook, secret, 15*time.Second)
		if err != nil {
			return err
		}
		bridge, err := cerium.NewBridge(store, secret, sink)
		if err != nil {
			return err
		}
		server := &http.Server{Addr: listen, Handler: bridge, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 3 * time.Minute, IdleTimeout: 30 * time.Second}
		go func() {
			ticker := time.NewTicker(30 * time.Second)
			defer ticker.Stop()
			for {
				if err := bridge.Maintain(ctx); err != nil {
					fmt.Fprintln(stderr, "Cerium bridge maintenance failed; cleanup will retry")
				}
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
				}
			}
		}()
		done := make(chan struct{})
		go func() {
			defer close(done)
			<-ctx.Done()
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 160*time.Second)
			defer cancel()
			server.Shutdown(shutdownCtx)
		}()
		fmt.Fprintln(stderr, "Cerium bridge listening on", listen)
		err = server.ListenAndServe()
		if errors.Is(err, http.ErrServerClosed) {
			<-done
			return nil
		}
		return err
	case "import":
		reader := in
		if config != "-" {
			file, err := os.Open(config)
			if err != nil {
				return err
			}
			defer file.Close()
			reader = file
		}
		n, err := store.Import(ctx, reader)
		if err != nil {
			return err
		}
		return encoder.Encode(map[string]int{"imported": n})
	case "list":
		credentials, err := store.Credentials(ctx)
		if err != nil {
			return err
		}
		return encoder.Encode(credentials)
	case "show":
		sites, err := store.Sites(ctx)
		if err != nil {
			return err
		}
		return encoder.Encode(sites)
	case "remove":
		if err := store.Remove(ctx, id); err != nil {
			return err
		}
		return encoder.Encode(map[string]int64{"removed": id})
	default:
		syncer := cerium.Syncer{Store: store, RequestTimeout: requestTimeout, SiteTimeout: siteTimeout}
		if webhook != "" {
			sink, err := cerium.NewWebhook(webhook, os.Getenv("CERIUM_WEBHOOK_SECRET"), requestTimeout)
			if err != nil {
				return err
			}
			syncer.Sinks = []cerium.Sink{sink}
		}
		results, runErr := syncer.Run(ctx)
		return errors.Join(encoder.Encode(results), runErr)
	}
}
