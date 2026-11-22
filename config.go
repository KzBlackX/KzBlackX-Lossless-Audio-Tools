package main

import (
	"errors"
	"flag"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config holds every runtime knob of the server. Values can come from CLI
// flags or from KZBX_* environment variables (flags win).
type Config struct {
	Addr       string
	TLSCert    string
	TLSKey     string
	ACMEDomain string
	ACMEEmail  string
	HTTPAddr   string
	HTTPSAddr  string

	// PublicIP is the address clients should reach. It is required when the
	// server sits behind 1:1 NAT (Tencent Cloud, AWS, ...). Empty means the
	// host's own interface addresses are advertised.
	PublicIP string
	UDPPort  int

	Password    string
	ServerName  string
	MaxRoom     int
	MaxRooms    int
	MaxBitrate  int
	IdleRoomTTL time.Duration

	FilesDir  string
	MaxFileMB int
	FileTTL   time.Duration

	Rooms      []string
	LogLevel   string
	TrustProxy bool
}

const defaultRooms = "大厅,游戏,音乐"

// version is overridden at build time with -ldflags "-X main.version=...".
var version = "0.1.0"

func loadConfig(args []string) (*Config, error) {
	c := &Config{}
	fs := flag.NewFlagSet("kzblackx-audio", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)

	fs.StringVar(&c.Addr, "addr", env("KZBX_ADDR", ":8080"), "HTTP listen address when TLS is not enabled")
	fs.StringVar(&c.TLSCert, "tls-cert", env("KZBX_TLS_CERT", ""), "path to TLS certificate (PEM)")
	fs.StringVar(&c.TLSKey, "tls-key", env("KZBX_TLS_KEY", ""), "path to TLS private key (PEM)")
	fs.StringVar(&c.ACMEDomain, "acme", env("KZBX_ACME_DOMAIN", ""), "enable automatic HTTPS for this domain via Let's Encrypt")
	fs.StringVar(&c.ACMEEmail, "acme-email", env("KZBX_ACME_EMAIL", ""), "contact e-mail for ACME account")
	fs.StringVar(&c.HTTPAddr, "http-addr", env("KZBX_HTTP_ADDR", ":80"), "listen address for ACME HTTP-01 / redirects")
	fs.StringVar(&c.HTTPSAddr, "https-addr", env("KZBX_HTTPS_ADDR", ":443"), "listen address for ACME HTTPS")

	fs.StringVar(&c.PublicIP, "public-ip", env("KZBX_PUBLIC_IP", ""), "public IP advertised in ICE candidates (behind NAT)")
	fs.IntVar(&c.UDPPort, "udp-port", envInt("KZBX_UDP_PORT", 3478), "single UDP port used for all WebRTC media")

	fs.StringVar(&c.Password, "password", env("KZBX_PASSWORD", ""), "server password (empty = open server)")
	fs.StringVar(&c.ServerName, "name", env("KZBX_NAME", "KzBlackX Lossless Audio Tools"), "server display name")
	fs.IntVar(&c.MaxRoom, "max-room", envInt("KZBX_MAX_ROOM", 16), "maximum participants per room")
	fs.IntVar(&c.MaxRooms, "max-rooms", envInt("KZBX_MAX_ROOMS", 32), "maximum number of rooms")
	fs.IntVar(&c.MaxBitrate, "max-bitrate", envInt("KZBX_MAX_BITRATE", 510), "hard cap for Opus bitrate in kbps (24-510)")
	fs.DurationVar(&c.IdleRoomTTL, "idle-room-ttl", envDuration("KZBX_IDLE_ROOM_TTL", 6*time.Hour), "delete empty, non-default rooms after this duration")
	fs.StringVar(&c.FilesDir, "files-dir", env("KZBX_FILES_DIR", "./data/files"), "directory for temporary room files")
	fs.IntVar(&c.MaxFileMB, "max-file-mb", envInt("KZBX_MAX_FILE_MB", 100), "maximum upload size per file in MiB (1-1024)")
	fs.DurationVar(&c.FileTTL, "file-ttl", envDuration("KZBX_FILE_TTL", 24*time.Hour), "delete uploaded files after this duration")

	showVersion := fs.Bool("version", false, "print version and exit")
	rooms := fs.String("rooms", env("KZBX_ROOMS", defaultRooms), "comma separated list of permanent rooms")
	fs.StringVar(&c.LogLevel, "log-level", env("KZBX_LOG_LEVEL", "info"), "debug, info, warn or error")
	fs.BoolVar(&c.TrustProxy, "trust-proxy", envBool("KZBX_TRUST_PROXY", false), "trust X-Forwarded-For when behind a reverse proxy")

	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	if *showVersion {
		fmt.Println("kzblackx-audio", version)
		os.Exit(0)
	}
	if fs.NArg() > 0 {
		return nil, fmt.Errorf("unexpected argument: %s", fs.Arg(0))
	}

	for _, r := range strings.Split(*rooms, ",") {
		r = cleanRoom(r)
		if r != "" && !contains(c.Rooms, r) {
			c.Rooms = append(c.Rooms, r)
		}
	}
	if len(c.Rooms) == 0 {
		c.Rooms = []string{"大厅"}
	}
	if c.PublicIP != "" && net.ParseIP(c.PublicIP) == nil {
		return nil, fmt.Errorf("invalid --public-ip %q", c.PublicIP)
	}
	if c.UDPPort < 1 || c.UDPPort > 65535 {
		return nil, fmt.Errorf("--udp-port must be 1-65535")
	}
	if c.MaxBitrate < 24 {
		c.MaxBitrate = 24
	}
	if c.MaxBitrate > 510 {
		c.MaxBitrate = 510
	}
	if c.MaxRoom < 2 {
		c.MaxRoom = 2
	}
	if c.MaxRooms < 1 {
		c.MaxRooms = 1
	}
	if c.MaxFileMB < 1 {
		c.MaxFileMB = 1
	}
	if c.MaxFileMB > 1024 {
		c.MaxFileMB = 1024
	}
	if c.FileTTL < 5*time.Minute {
		c.FileTTL = 5 * time.Minute
	}
	if c.FilesDir == "" {
		c.FilesDir = "./data/files"
	}
	if (c.TLSCert == "") != (c.TLSKey == "") {
		return nil, errors.New("--tls-cert and --tls-key must be given together")
	}
	if c.ACMEDomain != "" && c.TLSCert != "" {
		return nil, errors.New("--acme and --tls-cert are mutually exclusive")
	}
	switch c.LogLevel {
	case "debug", "info", "warn", "error":
	default:
		return nil, fmt.Errorf("invalid --log-level %q", c.LogLevel)
	}
	cleanRooms := c.Rooms[:0]
	for _, r := range c.Rooms {
		if r = cleanRoom(r); r != "" && !contains(cleanRooms, r) {
			cleanRooms = append(cleanRooms, r)
		}
	}
	c.Rooms = cleanRooms
	return c, nil
}

func (c *Config) tlsEnabled() bool { return c.TLSCert != "" || c.ACMEDomain != "" }

func (c *Config) isDefaultRoom(name string) bool { return contains(c.Rooms, name) }

func contains(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}

func env(key, def string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v, ok := os.LookupEnv(key); ok {
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
			return n
		}
	}
	return def
}

func envBool(key string, def bool) bool {
	if v, ok := os.LookupEnv(key); ok {
		if b, err := strconv.ParseBool(strings.TrimSpace(v)); err == nil {
			return b
		}
	}
	return def
}

func envDuration(key string, def time.Duration) time.Duration {
	if v, ok := os.LookupEnv(key); ok {
		if d, err := time.ParseDuration(strings.TrimSpace(v)); err == nil {
			return d
		}
	}
	return def
}
