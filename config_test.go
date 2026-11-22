package main

import (
	"strings"
	"testing"
	"time"
)

func TestLoadConfigDefaults(t *testing.T) {
	cfg, err := loadConfig(nil)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.UDPPort != 3478 || cfg.MaxRoom != 16 || cfg.MaxBitrate != 510 {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
	if len(cfg.Rooms) != 3 || cfg.Rooms[0] != "大厅" {
		t.Fatalf("rooms: %v", cfg.Rooms)
	}
}

func TestLoadConfigRoomsAreCleaned(t *testing.T) {
	cfg, err := loadConfig([]string{"--rooms", " 大厅 ,  游戏,大厅, ,  a  b "})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"大厅", "游戏", "a b"}
	if strings.Join(cfg.Rooms, "|") != strings.Join(want, "|") {
		t.Fatalf("got %v want %v", cfg.Rooms, want)
	}
}

func TestLoadConfigTLSValidation(t *testing.T) {
	if _, err := loadConfig([]string{"--tls-cert", "a.pem"}); err == nil {
		t.Fatal("cert without key must fail")
	}
	if _, err := loadConfig([]string{"--acme", "voice.example.com", "--tls-cert", "a.pem", "--tls-key", "b.pem"}); err == nil {
		t.Fatal("acme + cert must fail")
	}
}

func TestLoadConfigBadIP(t *testing.T) {
	if _, err := loadConfig([]string{"--public-ip", "not-an-ip"}); err == nil {
		t.Fatal("invalid public ip must fail")
	}
}

func TestLoadConfigEnvironment(t *testing.T) {
	t.Setenv("KZBX_PASSWORD", "s3cret")
	t.Setenv("KZBX_MAX_ROOM", "8")
	t.Setenv("KZBX_IDLE_ROOM_TTL", "90m")
	cfg, err := loadConfig(nil)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Password != "s3cret" || cfg.MaxRoom != 8 || cfg.IdleRoomTTL != 90*time.Minute {
		t.Fatalf("env not applied: %+v", cfg)
	}
}

func TestCleanName(t *testing.T) {
	cases := map[string]string{
		"":                               "访客",
		"  a\nb  ":                       "a b",
		"名字":                             "名字",
		"012345678901234567890123456789": "012345678901234567890123",
	}
	for in, want := range cases {
		if got := cleanName(in); got != want {
			t.Fatalf("cleanName(%q)=%q want %q", in, got, want)
		}
	}
}
