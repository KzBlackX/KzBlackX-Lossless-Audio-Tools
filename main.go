// KzBlackX Lossless Audio Tools — a tiny self-hosted voice room.
//
// The server is a selective forwarding unit: it terminates WebRTC, reads Opus
// RTP packets from every participant and forwards them to the other
// participants without decoding or re-encoding. Because the expensive part of
// voice chat (echo cancellation, encoding, jitter buffering) happens in the
// browser, the server idles at a few megabytes and stays flat as rooms grow.
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"golang.org/x/crypto/acme"
	"golang.org/x/crypto/acme/autocert"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return
		}
		fmt.Fprintln(os.Stderr, "kzblackx-audio:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	cfg, err := loadConfig(args)
	if err != nil {
		return err
	}

	logger := newLogger(cfg.LogLevel)
	slog.SetDefault(logger)
	logger.Info("starting KzBlackX Lossless Audio Tools", "version", version, "name", cfg.ServerName)

	hub, err := NewHub(cfg, logger)
	if err != nil {
		return err
	}
	defer hub.Close()

	app := &App{cfg: cfg, hub: hub, log: logger, started: time.Now()}
	mux := app.routes()

	srv := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelWarn),
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	errCh := make(chan error, 2)
	go func() {
		if cfg.ACMEDomain != "" {
			errCh <- app.serveACME(srv, logger)
			return
		}
		if cfg.TLSCert != "" {
			srv.Addr = cfg.Addr
			logger.Info("https listening", "addr", cfg.Addr)
			errCh <- srv.ListenAndServeTLS(cfg.TLSCert, cfg.TLSKey)
			return
		}
		srv.Addr = cfg.Addr
		logger.Warn("running plain HTTP — browsers only allow microphone access on HTTPS or localhost")
		logger.Info("http listening", "addr", cfg.Addr)
		errCh <- srv.ListenAndServe()
	}()

	if cfg.Password == "" {
		logger.Warn("no password set — anyone who can reach this server may join; use --password or KZBX_PASSWORD")
	}
	if cfg.PublicIP == "" && cfg.UDPPort != 0 {
		logger.Info("no --public-ip configured; the server advertises its local interface addresses",
			"hint", "set --public-ip when running behind NAT")
	}

	select {
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		logger.Info("shutting down")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Warn("http shutdown", "err", err)
	}
	return nil
}

func (a *App) serveACME(srv *http.Server, logger *slog.Logger) error {
	manager := &autocert.Manager{
		Prompt:     autocert.AcceptTOS,
		Cache:      autocert.DirCache(env("KZBX_ACME_CACHE", ".acme-cache")),
		HostPolicy: autocert.HostWhitelist(a.cfg.ACMEDomain),
	}
	if a.cfg.ACMEEmail != "" {
		manager.Email = a.cfg.ACMEEmail
	}

	// HTTP-01 challenge + permanent redirect to HTTPS.
	go func() {
		redirect := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			host := a.cfg.ACMEDomain
			if h, _, err := net.SplitHostPort(r.Host); err == nil {
				host = h
			}
			target := "https://" + host + r.URL.RequestURI()
			http.Redirect(w, r, target, http.StatusMovedPermanently)
		})
		httpSrv := &http.Server{
			Addr:              a.cfg.HTTPAddr,
			Handler:           manager.HTTPHandler(redirect),
			ReadHeaderTimeout: 10 * time.Second,
			ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelWarn),
		}
		logger.Info("acme http listener", "addr", a.cfg.HTTPAddr)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("acme http listener", "err", err)
		}
	}()

	srv.Addr = a.cfg.HTTPSAddr
	srv.TLSConfig = &tls.Config{
		GetCertificate: manager.GetCertificate,
		NextProtos:     []string{acme.ALPNProto, "h2", "http/1.1"},
		MinVersion:     tls.VersionTLS12,
	}
	logger.Info("https listening (autocert)", "addr", a.cfg.HTTPSAddr, "domain", a.cfg.ACMEDomain)
	err := srv.ListenAndServeTLS("", "")
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func newLogger(level string) *slog.Logger {
	var lv slog.Level
	switch level {
	case "debug":
		lv = slog.LevelDebug
	case "warn":
		lv = slog.LevelWarn
	case "error":
		lv = slog.LevelError
	default:
		lv = slog.LevelInfo
	}
	h := slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: lv})
	return slog.New(h).With("app", "kzblackx-audio")
}

// cleanRoom normalizes a room name: trims space, collapses whitespace and
// enforces a byte budget.
func cleanRoom(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if len([]rune(s)) > 24 {
		s = string([]rune(s)[:24])
	}
	return s
}
