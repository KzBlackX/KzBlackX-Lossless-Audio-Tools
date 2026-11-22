package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/interceptor"
	"github.com/pion/webrtc/v4"
	"golang.org/x/crypto/bcrypt"
)

// Hub owns every connected peer, every room and the shared WebRTC plumbing.
// Membership changes are guarded by mu; media packets never touch it.
type Hub struct {
	cfg *Config
	log *slog.Logger
	api *webrtc.API

	udpConn *net.UDPConn
	udpMux  ice.UDPMux

	mu      sync.RWMutex
	rooms   map[string]*Room
	peers   map[string]*Peer // every connected peer, lobby included
	tokens  map[string]*Peer // session token -> peer, for HTTP uploads
	files   map[string]*fileMeta
	fileDir string
	closed  bool

	nextRoomOrder int

	started time.Time
	done    chan struct{}

	// Server-password rate limiting (per IP).
	limitMu sync.Mutex
	fails   map[string]*failBucket

	txPackets atomic.Uint64
	txBytes   atomic.Uint64
	drops     atomic.Uint64

	lastCPU  time.Duration
	lastWall time.Time
	statMu   sync.Mutex
}

type Room struct {
	Name         string
	Order        int
	Created      time.Time
	EmptySince   time.Time
	Permanent    bool
	PasswordHash string // bcrypt; empty means open room
	FileToken    string // stable room token used by file/screen links
	Screen       *screenState
	CreatedBy    string
	Peers        map[string]*Peer
	Msgs         []chatMessage
	FlacPeer     string // participant currently sending the lossless side channel
}

type failBucket struct {
	Count int
	Reset time.Time
}

type joinError struct {
	code string
	msg  string
}

func (e *joinError) Error() string { return e.msg }

// RoomJoined carries everything a client needs after entering a room.
type RoomJoined struct {
	Room      roomInfo
	Peers     []peerInfo
	History   []chatMessage
	FileToken string
	Files     []fileInfo
	Screen    *screenInfo
}

func NewHub(cfg *Config, logger *slog.Logger) (*Hub, error) {
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4zero, Port: cfg.UDPPort})
	if err != nil {
		return nil, fmt.Errorf("listen UDP %d: %w", cfg.UDPPort, err)
	}
	udpMux := ice.NewUDPMuxDefault(ice.UDPMuxParams{UDPConn: conn})

	settings := webrtc.SettingEngine{}
	settings.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	settings.SetICEUDPMux(udpMux)
	if cfg.PublicIP != "" {
		settings.SetNAT1To1IPs([]string{cfg.PublicIP}, webrtc.ICECandidateTypeHost)
	}
	// A longer failed timeout is friendlier to phones that briefly lose Wi-Fi.
	settings.SetICETimeouts(8*time.Second, 25*time.Second, 2*time.Second)

	media := &webrtc.MediaEngine{}
	if err := media.RegisterDefaultCodecs(); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("register codecs: %w", err)
	}
	registry := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(media, registry); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("register interceptors: %w", err)
	}
	api := webrtc.NewAPI(
		webrtc.WithMediaEngine(media),
		webrtc.WithSettingEngine(settings),
		webrtc.WithInterceptorRegistry(registry),
	)

	h := &Hub{
		cfg:     cfg,
		log:     logger.With("component", "hub"),
		api:     api,
		udpConn: conn,
		udpMux:  udpMux,
		rooms:   make(map[string]*Room),
		peers:   make(map[string]*Peer),
		tokens:  make(map[string]*Peer),
		files:   make(map[string]*fileMeta),
		started: time.Now(),
		done:    make(chan struct{}),
		fails:   make(map[string]*failBucket),
	}
	for i, name := range cfg.Rooms {
		h.rooms[name] = &Room{Name: name, Order: i, Created: time.Now(), Permanent: true, FileToken: newToken(), Peers: make(map[string]*Peer)}
	}
	h.nextRoomOrder = len(cfg.Rooms)
	h.log.Info("media endpoint ready", "udp_port", cfg.UDPPort, "public_ip", cfg.PublicIP)
	if err := h.initFiles(); err != nil {
		_ = conn.Close()
		return nil, err
	}
	go h.statsLoop()
	go h.janitor()
	go h.filesLoop()
	return h, nil
}

func (h *Hub) Close() {
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return
	}
	h.closed = true
	peers := make([]*Peer, 0, len(h.peers))
	for _, p := range h.peers {
		peers = append(peers, p)
	}
	h.mu.Unlock()

	close(h.done)
	for _, p := range peers {
		p.shutdown()
	}
	_ = h.udpMux.Close()
}

// login authenticates the server password and creates a lobby-level session.
// The peer is not in any room yet.
func (h *Hub) login(ip, name, password string) (*Peer, []roomInfo, error) {
	if !h.authAllowed(ip) {
		return nil, nil, &joinError{code: "rate_limited", msg: "尝试过于频繁，请稍后再试"}
	}
	if h.cfg.Password != "" && !constantTimeEqual(password, h.cfg.Password) {
		h.recordFailure(ip)
		return nil, nil, &joinError{code: "bad_password", msg: "服务器密码不正确"}
	}
	h.clearFailures(ip)

	name = cleanName(name)
	p := newPeer(h, newID(), name, ip, 96)
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return nil, nil, &joinError{code: "closed", msg: "服务器正在关闭"}
	}
	p.token = newToken()
	h.peers[p.id] = p
	h.tokens[p.token] = p
	rooms := h.roomsLocked()
	h.mu.Unlock()
	return p, rooms, nil
}

// joinRoom moves a logged-in peer into a room. The caller must have left the
// previous room first.
func (h *Hub) joinRoom(p *Peer, roomName, password string) (*RoomJoined, error) {
	roomName = cleanRoom(roomName)
	if roomName == "" {
		roomName = h.cfg.Rooms[0]
	}

	h.mu.RLock()
	room := h.rooms[roomName]
	hash := ""
	if room != nil {
		hash = room.PasswordHash
	}
	h.mu.RUnlock()
	if room == nil {
		return nil, &joinError{code: "room_not_found", msg: "房间不存在"}
	}
	if hash != "" {
		if !p.allowRoomAuth() {
			return nil, &joinError{code: "rate_limited", msg: "尝试过于频繁，请稍后再试"}
		}
		if bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
			p.recordRoomAuthFail()
			return nil, &joinError{code: "room_password", msg: "房间密码不正确"}
		}
		p.clearRoomAuthFails()
	}

	h.mu.Lock()
	if p.room != nil {
		h.mu.Unlock()
		return nil, &joinError{code: "already_in_room", msg: "你已经在一个房间里"}
	}
	room = h.rooms[roomName]
	if room == nil {
		h.mu.Unlock()
		return nil, &joinError{code: "room_not_found", msg: "房间不存在"}
	}
	if len(room.Peers) >= h.cfg.MaxRoom {
		h.mu.Unlock()
		return nil, &joinError{code: "room_full", msg: "房间已满"}
	}
	p.name = uniqueName(room, p.baseName)
	p.room = room
	p.roomJoinedAt = time.Now()
	p.source = newSource(p.id)
	p.source.hub = h
	room.Peers[p.id] = p
	room.EmptySince = time.Time{}
	peers := make([]peerInfo, 0, len(room.Peers))
	for _, other := range room.Peers {
		peers = append(peers, other.info())
	}
	info := roomInfo{Name: room.Name, Count: len(room.Peers), Permanent: room.Permanent, Locked: room.PasswordHash != ""}
	history := append([]chatMessage(nil), room.Msgs...)
	files := h.fileListLocked(room.Name)
	fileToken := room.FileToken
	screen := screenInfoLocked(room)
	h.mu.Unlock()

	return &RoomJoined{Room: info, Peers: peers, History: history, Files: files, FileToken: fileToken, Screen: screen}, nil
}

// createRoom adds a new (optionally password-protected) room and joins it.
func (h *Hub) createRoom(p *Peer, name, password string) (*RoomJoined, error) {
	if p.room != nil {
		return nil, &joinError{code: "already_in_room", msg: "请先离开当前房间"}
	}
	name = cleanRoom(name)
	if name == "" {
		return nil, &joinError{code: "bad_room", msg: "房间名不能为空"}
	}
	if len(password) > 128 {
		password = password[:128]
	}
	hash := ""
	if password != "" {
		b, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
		if err != nil {
			return nil, &joinError{code: "internal", msg: "无法设置房间密码"}
		}
		hash = string(b)
	}

	h.mu.Lock()
	if _, exists := h.rooms[name]; exists {
		h.mu.Unlock()
		return nil, &joinError{code: "room_exists", msg: "同名房间已经存在"}
	}
	if len(h.rooms) >= h.cfg.MaxRooms {
		h.mu.Unlock()
		return nil, &joinError{code: "too_many_rooms", msg: "房间数量已达上限"}
	}
	h.rooms[name] = &Room{
		Name:         name,
		Order:        h.nextRoomOrder,
		Created:      time.Now(),
		FileToken:    newToken(),
		PasswordHash: hash,
		CreatedBy:    p.id,
		Peers:        make(map[string]*Peer),
	}
	h.nextRoomOrder++
	h.mu.Unlock()

	return h.joinRoom(p, name, password)
}

// leaveRoom detaches a peer from its room and drops its media. It keeps the
// WebSocket session alive; notify tells the client explicitly.
func (h *Hub) leaveRoom(p *Peer, reason string, notify bool) *Room {
	h.mu.Lock()
	room := p.room
	if room == nil {
		h.mu.Unlock()
		if notify {
			p.send(msgRoomLeft{T: "room-left", Reason: reason})
		}
		return nil
	}
	delete(room.Peers, p.id)
	if len(room.Peers) == 0 {
		room.EmptySince = time.Now()
	}
	flacStopped := false
	if room.FlacPeer == p.id {
		room.FlacPeer = ""
		flacStopped = true
	}
	screenStopped := room.Screen != nil && room.Screen.PeerID == p.id
	if screenStopped {
		room.Screen = nil
	}
	others := make([]*Peer, 0, len(room.Peers))
	for _, o := range room.Peers {
		others = append(others, o)
	}
	p.room = nil
	p.name = p.baseName
	roomName := room.Name
	h.mu.Unlock()

	p.pcMu.Lock()
	p.teardownPCLocked()
	if p.source != nil {
		p.source.close()
		p.source = nil
	}
	p.pcMu.Unlock()
	p.closeVideoSource()

	for _, o := range others {
		o.removeSink(p.id)
		o.removeVideoSink(p.id)
	}
	h.broadcast(room, "", msgPeerLeft{T: "peer-left", ID: p.id})
	if flacStopped {
		h.broadcast(room, "", msgFlacStopped{T: "flac-stopped", ID: p.id, Reason: "left"})
	}
	if screenStopped {
		h.broadcast(room, "", msgScreenStopped{T: "screen-stopped", ID: p.id, Reason: "left"})
	}
	h.broadcastRooms()
	if notify {
		p.send(msgRoomLeft{T: "room-left", Room: roomName, Reason: reason})
	}
	h.log.Info("peer left room", "id", p.id, "name", p.name, "room", roomName)
	return room
}

func (h *Hub) removePeer(p *Peer) {
	p.closeOnce.Do(func() {
		h.leaveRoom(p, "disconnect", false)
		h.mu.Lock()
		delete(h.peers, p.id)
		if p.token != "" {
			delete(h.tokens, p.token)
		}
		h.mu.Unlock()
		p.shutdown()
		h.broadcastRooms()
		h.log.Info("peer disconnected", "id", p.id, "name", p.name)
	})
}

// newPeerConnection builds the server side of a single participant's call.
func (h *Hub) newPeerConnection(p *Peer) (*webrtc.PeerConnection, error) {
	pc, err := h.api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return nil, err
	}
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		init := c.ToJSON()
		p.send(msgCandidate{T: "candidate", Candidate: &init})
	})
	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		p.readTrack(track)
	})
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		h.log.Debug("peer connection state", "id", p.id, "state", state.String())
		if state == webrtc.PeerConnectionStateFailed {
			p.log.Info("media connection failed")
			go p.close("media failed")
		}
	})
	return pc, nil
}

// sourceWentLive makes every other participant subscribe to a newly published
// stream. Subscriptions are created lazily because a participant may join
// without a microphone.
func (h *Hub) sourceWentLive(p *Peer) {
	if p.source == nil {
		return
	}
	for _, other := range h.peersExcept(p) {
		other.subscribe(p.source)
	}
}

func (h *Hub) broadcast(room *Room, except string, v any) {
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
		p.send(v)
	}
}

func (h *Hub) broadcastAll(v any) {
	h.mu.RLock()
	targets := make([]*Peer, 0, len(h.peers))
	for _, p := range h.peers {
		targets = append(targets, p)
	}
	h.mu.RUnlock()
	for _, p := range targets {
		p.send(v)
	}
}

func (h *Hub) broadcastRooms() {
	h.mu.RLock()
	rooms := h.roomsLocked()
	h.mu.RUnlock()
	h.broadcastAll(msgRooms{T: "rooms", Rooms: rooms})
}

// roomsLocked must be called with h.mu held.
func (h *Hub) roomsLocked() []roomInfo {
	// Room order is fixed: configured rooms first, then rooms in creation order.
	// Never move the room the caller is in to the top.
	rooms := make([]*Room, 0, len(h.rooms))
	for _, r := range h.rooms {
		rooms = append(rooms, r)
	}
	sort.Slice(rooms, func(i, j int) bool {
		return rooms[i].Order < rooms[j].Order
	})
	out := make([]roomInfo, 0, len(rooms))
	for _, r := range rooms {
		out = append(out, roomInfo{
			Name:      r.Name,
			Count:     len(r.Peers),
			Permanent: r.Permanent,
			Locked:    r.PasswordHash != "",
		})
	}
	return out
}

func (h *Hub) peersExcept(p *Peer) []*Peer {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]*Peer, 0, 8)
	if p.room == nil {
		return out
	}
	for id, other := range p.room.Peers {
		if id != p.id {
			out = append(out, other)
		}
	}
	return out
}

func (h *Hub) peerCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.peers)
}

func (h *Hub) inRoomCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	n := 0
	for _, r := range h.rooms {
		n += len(r.Peers)
	}
	return n
}

func (h *Hub) roomCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.rooms)
}

func uniqueName(room *Room, name string) string {
	taken := func(n string) bool {
		for _, p := range room.Peers {
			if p.name == n {
				return true
			}
		}
		return false
	}
	if !taken(name) {
		return name
	}
	base := name
	if len([]rune(base)) > 20 {
		base = string([]rune(base)[:20])
	}
	for i := 2; i < 100; i++ {
		candidate := fmt.Sprintf("%s %d", base, i)
		if !taken(candidate) {
			return candidate
		}
	}
	return base + " " + newID()[:4]
}

func cleanName(s string) string {
	s = strings.TrimSpace(strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == '\t' {
			return ' '
		}
		if r < 0x20 {
			return -1
		}
		return r
	}, s))
	s = strings.Join(strings.Fields(s), " ")
	if s == "" {
		s = "访客"
	}
	if runes := []rune(s); len(runes) > 24 {
		s = string(runes[:24])
	}
	return s
}

func newID() string {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		return hex.EncodeToString([]byte(fmt.Sprintf("%08d", time.Now().UnixNano()%100000000)))
	}
	return hex.EncodeToString(b[:])
}

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func (h *Hub) authAllowed(ip string) bool {
	h.limitMu.Lock()
	defer h.limitMu.Unlock()
	b := h.fails[ip]
	if b == nil || time.Now().After(b.Reset) {
		return true
	}
	return b.Count < 20
}

func (h *Hub) recordFailure(ip string) {
	h.limitMu.Lock()
	defer h.limitMu.Unlock()
	b := h.fails[ip]
	now := time.Now()
	if b == nil || now.After(b.Reset) {
		b = &failBucket{Reset: now.Add(5 * time.Minute)}
		h.fails[ip] = b
	}
	b.Count++
}

func (h *Hub) clearFailures(ip string) {
	h.limitMu.Lock()
	delete(h.fails, ip)
	h.limitMu.Unlock()
}

func (h *Hub) statsLoop() {
	ticker := time.NewTicker(4 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-h.done:
			return
		case <-ticker.C:
			s := h.snapshotStats()
			h.broadcastAll(s)
		}
	}
}

func (h *Hub) janitor() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-h.done:
			return
		case now := <-ticker.C:
			h.mu.Lock()
			changed := false
			var deletedRooms []string
			for name, r := range h.rooms {
				if r.Permanent || len(r.Peers) > 0 {
					continue
				}
				if r.EmptySince.IsZero() {
					r.EmptySince = now
					continue
				}
				if now.Sub(r.EmptySince) > h.cfg.IdleRoomTTL {
					delete(h.rooms, name)
					deletedRooms = append(deletedRooms, name)
					changed = true
				}
			}
			h.limitMu.Lock()
			for ip, b := range h.fails {
				if now.After(b.Reset) {
					delete(h.fails, ip)
				}
			}
			h.limitMu.Unlock()
			h.mu.Unlock()
			for _, name := range deletedRooms {
				h.purgeRoomFiles(name)
			}
			if changed {
				h.broadcastRooms()
			}
		}
	}
}
