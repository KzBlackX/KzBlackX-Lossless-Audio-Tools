package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"time"
)

// Low-footprint screen sharing: the sharer renders JPEG frames in the browser
// and uploads them over HTTP. The server keeps only the latest frame in memory
// and viewers poll it. No video transcoding and no extra media port.

const (
	maxScreenFrame = 2 << 20
	maxScreenRate  = 16 << 20 // bytes per second per sharer
	maxScreenFPS   = 120
)

type screenState struct {
	PeerID   string
	PeerName string
	Width    int
	Height   int
	FPS      int
	Bitrate  int
	Seq      uint64
	Frame    []byte
	Updated  time.Time
}

func screenInfoLocked(room *Room) *screenInfo {
	if room == nil || room.Screen == nil {
		return nil
	}
	s := room.Screen
	return &screenInfo{
		Peer:    peerInfo{ID: s.PeerID, Name: s.PeerName},
		Width:   s.Width,
		Height:  s.Height,
		FPS:     s.FPS,
		Bitrate: s.Bitrate,
		Seq:     s.Seq,
		Updated: s.Updated.UnixMilli(),
	}
}

func (p *Peer) handleScreenStart(m clientMsg) {
	h := p.hub
	width := clamp(m.Width, 160, 3840)
	height := clamp(m.Height, 90, 2160)
	fps := clamp(m.FPS, 1, maxScreenFPS)
	bitrate := clamp(m.ScreenBitrate, 256, 20000)

	h.mu.Lock()
	room := p.room
	if room == nil {
		h.mu.Unlock()
		p.send(msgError{T: "error", Code: "not_in_room", Message: "请先进入房间"})
		return
	}
	if room.Screen != nil && room.Screen.PeerID != p.id {
		h.mu.Unlock()
		p.send(msgError{T: "error", Code: "screen_busy", Message: "房间里已经有人在共享桌面"})
		return
	}
	room.Screen = &screenState{
		PeerID:   p.id,
		PeerName: p.name,
		Width:    width,
		Height:   height,
		FPS:      fps,
		Bitrate:  bitrate,
		Updated:  time.Now(),
	}
	info := *screenInfoLocked(room)
	h.mu.Unlock()

	h.broadcast(room, "", msgScreenStarted{T: "screen-started", Screen: info})
	p.log.Info("screen share started", "width", width, "height", height, "fps", fps, "bitrate", bitrate)
}

func (p *Peer) handleScreenStop() {
	h := p.hub
	h.mu.Lock()
	room := p.room
	changed := room != nil && room.Screen != nil && room.Screen.PeerID == p.id
	if changed {
		room.Screen = nil
	}
	h.mu.Unlock()
	if changed {
		h.broadcast(room, "", msgScreenStopped{T: "screen-stopped", ID: p.id, Reason: "stopped"})
		p.log.Info("screen share stopped")
	}
}

func (p *Peer) allowScreenBytes(n int) bool {
	p.screenMu.Lock()
	defer p.screenMu.Unlock()
	now := time.Now()
	if now.Sub(p.screenWindow) > time.Second {
		p.screenWindow = now
		p.screenBytes = 0
		p.screenFrames = 0
	}
	p.screenBytes += n
	p.screenFrames++
	return p.screenBytes <= maxScreenRate && p.screenFrames <= maxScreenFPS+3
}

func (a *App) handleScreenFrame(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		a.handleScreenUpload(w, r)
	case http.MethodGet, http.MethodHead:
		a.handleScreenView(w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (a *App) handleScreenUpload(w http.ResponseWriter, r *http.Request) {
	peer := a.hub.peerByToken(bearerToken(r))
	if peer == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	roomName := cleanRoom(r.URL.Query().Get("room"))
	r.Body = http.MaxBytesReader(w, r.Body, maxScreenFrame)
	frame, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "frame too large", http.StatusRequestEntityTooLarge)
		return
	}
	if len(frame) == 0 || len(frame) > maxScreenFrame {
		http.Error(w, "bad frame", http.StatusBadRequest)
		return
	}
	if len(frame) < 3 || frame[0] != 0xff || frame[1] != 0xd8 {
		http.Error(w, "expected jpeg", http.StatusBadRequest)
		return
	}
	if !peer.allowScreenBytes(len(frame)) {
		http.Error(w, "too many frames", http.StatusTooManyRequests)
		return
	}

	a.hub.mu.Lock()
	room := peer.room
	if room == nil || room.Name != roomName || room.Screen == nil || room.Screen.PeerID != peer.id {
		a.hub.mu.Unlock()
		http.Error(w, "not sharing", http.StatusConflict)
		return
	}
	room.Screen.Frame = append(room.Screen.Frame[:0], frame...)
	room.Screen.Seq++
	room.Screen.Updated = time.Now()
	seq := room.Screen.Seq
	a.hub.mu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]any{"seq": seq})
}

func (a *App) handleScreenView(w http.ResponseWriter, r *http.Request) {
	roomName := cleanRoom(r.URL.Query().Get("room"))
	token := r.URL.Query().Get("token")
	want, _ := strconv.ParseUint(r.URL.Query().Get("seq"), 10, 64)

	a.hub.mu.RLock()
	room := a.hub.rooms[roomName]
	if room == nil || !constantTimeEqual(token, room.FileToken) || room.Screen == nil {
		a.hub.mu.RUnlock()
		http.NotFound(w, r)
		return
	}
	s := room.Screen
	seq := s.Seq
	var frame []byte
	if seq != 0 && seq != want {
		frame = append([]byte(nil), s.Frame...)
	}
	a.hub.mu.RUnlock()

	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Screen-Seq", strconv.FormatUint(seq, 10))
	if len(frame) == 0 {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	if r.Method == http.MethodHead {
		w.Header().Set("Content-Length", strconv.Itoa(len(frame)))
		return
	}
	_, _ = io.Copy(w, bytes.NewReader(frame))
}
