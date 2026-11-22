package main

import (
	"encoding/json"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
)

// Peer is one participant: a WebSocket control channel plus one WebRTC peer
// connection that both publishes and subscribes to audio.
type Peer struct {
	hub      *Hub
	log      *slog.Logger
	id       string
	name     string
	baseName string
	ip       string
	token    string

	room         *Room
	joinedAt     time.Time
	roomJoinedAt time.Time
	muted        atomic.Bool
	bitrate      atomic.Int32 // desired Opus bitrate in kbps
	closed       atomic.Bool

	ws      *websocket.Conn
	writeMu sync.Mutex

	pcMu         sync.Mutex
	pc           *webrtc.PeerConnection
	sinks        map[string]*sink // publisher peer id -> forwarding track
	negotiating  bool             // a local offer is waiting for an answer
	pendingOffer bool             // media changed while an offer was in flight

	source *source // our published audio, stable across PC rebuilds

	closeOnce sync.Once
	done      chan struct{}

	chatMu   sync.Mutex
	chatSeen []time.Time

	flacMu     sync.Mutex
	flacWindow time.Time
	flacBytes  int

	screenMu     sync.Mutex
	screenWindow time.Time
	screenBytes  int
	screenFrames int

	roomAuthMu    sync.Mutex
	roomAuthFails int
	roomAuthReset time.Time
}

func newPeer(h *Hub, id, name, ip string, bitrate int) *Peer {
	p := &Peer{
		hub:      h,
		log:      h.log.With("peer", id),
		id:       id,
		name:     name,
		baseName: name,
		ip:       ip,
		joinedAt: time.Now(),
		sinks:    make(map[string]*sink),
		done:     make(chan struct{}),
	}
	p.bitrate.Store(int32(bitrate))
	return p
}

func (p *Peer) info() peerInfo {
	return peerInfo{ID: p.id, Name: p.name, Muted: p.muted.Load(), JoinedAt: p.joinedAt.UnixMilli()}
}

func (p *Peer) bitrateKbps() int { return int(p.bitrate.Load()) }

func (p *Peer) setPC(pc *webrtc.PeerConnection) {
	p.pcMu.Lock()
	p.pc = pc
	p.pcMu.Unlock()
}

// send writes one JSON frame. Frames are serialized by writeMu; a write error
// tears the peer down asynchronously (never from inside pcMu).
func (p *Peer) send(v any) {
	if p.closed.Load() {
		return
	}
	b, err := json.Marshal(v)
	if err != nil {
		p.log.Error("marshal frame", "err", err)
		return
	}
	p.writeMu.Lock()
	_ = p.ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
	err = p.ws.WriteMessage(websocket.TextMessage, b)
	p.writeMu.Unlock()
	if err != nil {
		p.log.Debug("write failed", "err", err)
		go p.close("write failed")
	}
}

func (p *Peer) close(reason string) {
	p.log.Debug("closing", "reason", reason)
	p.hub.removePeer(p)
}

// shutdown stops all resources. It is idempotent and is called by removePeer.
func (p *Peer) shutdown() {
	if p.closed.CompareAndSwap(false, true) {
		close(p.done)
	}
	if p.ws != nil {
		_ = p.ws.Close()
	}
	p.pcMu.Lock()
	p.teardownPCLocked()
	p.pcMu.Unlock()
	if p.source != nil {
		p.source.close()
	}
}

// teardownPCLocked closes the peer connection and unsubscribes from every
// source. It deliberately keeps p.source alive: the publishing path survives a
// client-side PC rebuild (quality switch).
func (p *Peer) teardownPCLocked() {
	if p.pc != nil {
		_ = p.pc.Close()
		p.pc = nil
	}
	for id, snk := range p.sinks {
		snk.stop()
		if snk.src != nil {
			snk.src.removeSink(snk)
		}
		delete(p.sinks, id)
	}
	p.negotiating = false
	p.pendingOffer = false
}

func (p *Peer) allowRoomAuth() bool {
	p.roomAuthMu.Lock()
	defer p.roomAuthMu.Unlock()
	now := time.Now()
	if now.After(p.roomAuthReset) {
		p.roomAuthFails = 0
		p.roomAuthReset = now.Add(2 * time.Minute)
	}
	return p.roomAuthFails < 6
}

func (p *Peer) recordRoomAuthFail() {
	p.roomAuthMu.Lock()
	p.roomAuthFails++
	if p.roomAuthReset.IsZero() {
		p.roomAuthReset = time.Now().Add(2 * time.Minute)
	}
	p.roomAuthMu.Unlock()
}

func (p *Peer) clearRoomAuthFails() {
	p.roomAuthMu.Lock()
	p.roomAuthFails = 0
	p.roomAuthMu.Unlock()
}

func (p *Peer) allowChat() bool {
	now := time.Now()
	p.chatMu.Lock()
	defer p.chatMu.Unlock()
	cut := now.Add(-2 * time.Second)
	kept := p.chatSeen[:0]
	for _, t := range p.chatSeen {
		if t.After(cut) {
			kept = append(kept, t)
		}
	}
	p.chatSeen = kept
	if len(kept) >= 6 {
		return false
	}
	p.chatSeen = append(p.chatSeen, now)
	return true
}

// allowFlacBytes applies a simple per-sender budget for the lossless channel
// (4 MiB/s). FLAC stereo at 48 kHz usually sits around 1 Mbps.
func (p *Peer) allowFlacBytes(n int) bool {
	p.flacMu.Lock()
	defer p.flacMu.Unlock()
	now := time.Now()
	if now.Sub(p.flacWindow) > time.Second {
		p.flacWindow = now
		p.flacBytes = 0
	}
	p.flacBytes += n
	return p.flacBytes <= maxFlacRate
}

func constantTimeEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	var diff byte
	for i := 0; i < len(a); i++ {
		diff |= a[i] ^ b[i]
	}
	return diff == 0
}
