package main

// Screen sharing state. The actual video RTP is forwarded by rtc.go; this file
// only owns the room-level "who is sharing" metadata.

const maxScreenFPS = 120

type screenState struct {
	PeerID   string
	PeerName string
	Width    int
	Height   int
	FPS      int
	Bitrate  int
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
	}
	info := *screenInfoLocked(room)
	h.mu.Unlock()

	// A restarted share replaces any previous video source.
	p.closeVideoSource()
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
		p.closeVideoSource()
		h.broadcast(room, "", msgScreenStopped{T: "screen-stopped", ID: p.id, Reason: "stopped"})
		p.log.Info("screen share stopped")
	}
}
