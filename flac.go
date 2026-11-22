package main

import (
	"time"

	"github.com/gorilla/websocket"
)

// FLAC lossless side channel.
//
// One participant per room may publish FLAC chunks. The server never touches
// the codec: it relays opaque FLAC byte chunks over the control WebSocket to
// the rest of the room. Chunks are standalone FLAC streams; the browser decodes
// them with decodeAudioData and schedules playback, so no WASM decoder ships
// to receivers.

const (
	maxFlacChunk   = 256 << 10
	maxFlacRate    = 4 << 20 // bytes per second per sender
	defaultChunkMS = 500
)

func (p *Peer) handleFlacStart(m clientMsg) {
	if p.closed.Load() {
		return
	}
	sampleRate := m.SampleRate
	if sampleRate < 8000 || sampleRate > 192000 {
		sampleRate = 48000
	}
	channels := clamp(m.Channels, 1, 2)
	bits := 16
	chunkMS := clamp(m.ChunkMS, 100, 2000)
	if chunkMS == 0 {
		chunkMS = defaultChunkMS
	}

	h := p.hub
	h.mu.Lock()
	if p.room == nil {
		h.mu.Unlock()
		p.send(msgError{T: "error", Code: "not_in_room", Message: "请先进入房间"})
		return
	}
	if p.room.FlacPeer != "" && p.room.FlacPeer != p.id {
		h.mu.Unlock()
		p.send(msgError{T: "error", Code: "flac_busy", Message: "房间里已经有人在发送无损音频"})
		return
	}
	p.room.FlacPeer = p.id
	room := p.room
	h.mu.Unlock()

	h.broadcast(room, "", msgFlacStarted{
		T:          "flac-started",
		Peer:       p.info(),
		SampleRate: sampleRate,
		Channels:   channels,
		Bits:       bits,
		ChunkMS:    chunkMS,
	})
	p.log.Info("flac sender started", "sample_rate", sampleRate, "channels", channels, "chunk_ms", chunkMS)
}

func (p *Peer) handleFlacStop() {
	h := p.hub
	h.mu.Lock()
	room := p.room
	changed := room != nil && room.FlacPeer == p.id
	if changed {
		room.FlacPeer = ""
	}
	h.mu.Unlock()
	if changed {
		h.broadcast(room, "", msgFlacStopped{T: "flac-stopped", ID: p.id, Reason: "stopped"})
		p.log.Info("flac sender stopped")
	}
}

func (p *Peer) handleFlacChunk(data []byte) {
	if len(data) == 0 || len(data) > maxFlacChunk {
		return
	}
	h := p.hub
	h.mu.RLock()
	room := p.room
	active := room != nil && room.FlacPeer == p.id
	h.mu.RUnlock()
	if !active || !p.allowFlacBytes(len(data)) {
		return
	}
	h.broadcastBinary(room, p.id, data)
}

func (h *Hub) broadcastBinary(room *Room, except string, data []byte) {
	if room == nil {
		return
	}
	h.mu.RLock()
	targets := make([]*Peer, 0, len(room.Peers))
	for id, p := range room.Peers {
		if id != except {
			targets = append(targets, p)
		}
	}
	h.mu.RUnlock()
	for _, p := range targets {
		p.sendBinary(data)
	}
}

func (p *Peer) sendBinary(b []byte) {
	if p.closed.Load() {
		return
	}
	p.writeMu.Lock()
	_ = p.ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
	err := p.ws.WriteMessage(websocket.BinaryMessage, b)
	p.writeMu.Unlock()
	if err != nil {
		p.log.Debug("binary write failed", "err", err)
		go p.close("write failed")
	}
}
