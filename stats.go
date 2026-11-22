package main

import (
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func (h *Hub) snapshotStats() msgStats {
	now := time.Now()
	rss := readRSS()

	h.statMu.Lock()
	var cpuPct float64
	if !h.lastWall.IsZero() {
		var ru syscall.Rusage
		if err := syscall.Getrusage(syscall.RUSAGE_SELF, &ru); err == nil {
			cpuNow := time.Duration(ru.Utime.Nano() + ru.Stime.Nano())
			wall := now.Sub(h.lastWall)
			delta := cpuNow - h.lastCPU
			if wall > 0 {
				cpuPct = float64(delta) / float64(wall) * 100
			}
			h.lastCPU = cpuNow
			h.lastWall = now
		}
	} else {
		var ru syscall.Rusage
		if err := syscall.Getrusage(syscall.RUSAGE_SELF, &ru); err == nil {
			h.lastCPU = time.Duration(ru.Utime.Nano() + ru.Stime.Nano())
		}
		h.lastWall = now
	}
	h.statMu.Unlock()

	return msgStats{
		T:          "stats",
		RSSBytes:   rss,
		CPU:        cpuPct,
		Uptime:     int64(now.Sub(h.started).Seconds()),
		Goroutines: runtime.NumGoroutine(),
		Peers:      h.peerCount(),
		InRooms:    h.inRoomCount(),
		Rooms:      h.roomCount(),
		TxPackets:  h.txPackets.Load(),
		TxBytes:    h.txBytes.Load(),
		Drops:      h.drops.Load(),
	}
}

// readRSS returns the current resident set size from /proc (Linux).
func readRSS() int64 {
	b, err := os.ReadFile("/proc/self/statm")
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(b))
	if len(fields) < 2 {
		return 0
	}
	pages, err := strconv.ParseInt(fields[1], 10, 64)
	if err != nil {
		return 0
	}
	return pages * int64(os.Getpagesize())
}
