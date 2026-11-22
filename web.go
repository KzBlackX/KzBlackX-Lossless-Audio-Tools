package main

import (
	"embed"
	"encoding/json"
	"io/fs"
	"log/slog"
	"net/http"
	"path"
	"strings"
	"time"
)

//go:embed web
var webFS embed.FS

type App struct {
	cfg     *Config
	hub     *Hub
	log     *slog.Logger
	started time.Time
}

func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", a.hub.ServeWS)
	mux.HandleFunc("/healthz", a.handleHealth)
	mux.HandleFunc("/api/info", a.handleInfo)
	mux.HandleFunc("/api/files/upload", a.handleFileUpload)
	mux.HandleFunc("/api/files/", a.handleFileDownload)
	mux.HandleFunc("/api/screen/frame", a.handleScreenFrame)
	mux.Handle("/", a.static())
	return a.securityHeaders(mux)
}

func (a *App) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Permissions-Policy", "microphone=(self), camera=(), geolocation=(), display-capture=(self)")
		h.Set("Content-Security-Policy",
			"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src 'self'; "+
				"img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; "+
				"font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
		if a.cfg.tlsEnabled() {
			h.Set("Strict-Transport-Security", "max-age=31536000")
		}
		next.ServeHTTP(w, r)
	})
}

func (a *App) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":      true,
		"version": version,
		"uptime":  int64(time.Since(a.started).Seconds()),
		"peers":   a.hub.peerCount(),
		"rooms":   a.hub.roomCount(),
	})
}

func (a *App) handleInfo(w http.ResponseWriter, r *http.Request) {
	a.hub.mu.RLock()
	rooms := a.hub.roomsLocked()
	a.hub.mu.RUnlock()
	stats := a.hub.snapshotStats()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"name":             a.cfg.ServerName,
		"version":          version,
		"requiresPassword": a.cfg.Password != "",
		"rooms":            rooms,
		"maxRoom":          a.cfg.MaxRoom,
		"maxBitrate":       a.cfg.MaxBitrate,
		"udpPort":          a.cfg.UDPPort,
		"peers":            stats.Peers,
		"stats":            stats,
	})
}

func (a *App) static() http.Handler {
	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		panic(err)
	}
	files := http.FileServer(http.FS(sub))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name == "" || name == "." {
			name = "index.html"
		}
		if f, err := sub.Open(name); err == nil {
			_ = f.Close()
			if strings.HasSuffix(name, ".wasm") {
				w.Header().Set("Content-Type", "application/wasm")
			}
			if name == "index.html" {
				w.Header().Set("Cache-Control", "no-store")
			} else {
				// Revalidate every load so a binary upgrade is picked up without
				// asking users to hard-refresh.
				w.Header().Set("Cache-Control", "no-cache")
			}
			files.ServeHTTP(w, r)
			return
		}
		// Single page app: unknown paths fall back to the shell.
		r = r.Clone(r.Context())
		r.URL.Path = "/"
		w.Header().Set("Cache-Control", "no-store")
		files.ServeHTTP(w, r)
	})
}
