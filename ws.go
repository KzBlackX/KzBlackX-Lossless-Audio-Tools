package main

import (
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 8192,
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true
		}
		u, err := url.Parse(origin)
		if err != nil {
			return false
		}
		return strings.EqualFold(u.Host, r.Host)
	},
}

// ServeWS is the single control endpoint: login, room list, SDP, ICE, chat,
// presence and the FLAC side channel all travel over this socket.
func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) {
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer func() { _ = ws.Close() }()
	ws.SetReadLimit(64 << 10)
	_ = ws.SetReadDeadline(time.Now().Add(15 * time.Second))

	_, data, err := ws.ReadMessage()
	if err != nil {
		return
	}
	var req clientMsg
	if err := json.Unmarshal(data, &req); err != nil || req.T != "login" {
		_ = writeFrame(ws, msgError{T: "error", Code: "bad_request", Message: "请先登录"})
		return
	}

	p, rooms, err := h.login(clientIP(r, h.cfg.TrustProxy), req.Name, req.Password)
	if err != nil {
		code, message := "login_failed", "无法登录"
		if je, ok := err.(*joinError); ok {
			code, message = je.code, je.msg
		}
		_ = writeFrame(ws, msgError{T: "error", Code: code, Message: message})
		_ = ws.WriteControl(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.ClosePolicyViolation, message),
			time.Now().Add(2*time.Second))
		return
	}

	p.ws = ws
	ws.SetPongHandler(func(string) error {
		return ws.SetReadDeadline(time.Now().Add(90 * time.Second))
	})
	_ = ws.SetReadDeadline(time.Now().Add(90 * time.Second))

	p.send(msgWelcome{
		T:     "welcome",
		Self:  p.info(),
		Rooms: rooms,
		Token: p.token,
		Settings: settingsInfo{
			Version:        version,
			ServerName:     h.cfg.ServerName,
			MaxBitrate:     h.cfg.MaxBitrate,
			DefaultBitrate: 96,
			MaxRoom:        h.cfg.MaxRoom,
			MaxRooms:       h.cfg.MaxRooms,
			UDPPort:        h.cfg.UDPPort,
			RequiresPass:   h.cfg.Password != "",
			MaxFileMB:      h.cfg.MaxFileMB,
		},
	})
	p.send(h.snapshotStats())
	h.broadcastRooms()
	h.log.Info("peer logged in", "id", p.id, "name", p.name, "ip", p.ip)

	go p.pinger()

	for {
		mt, data, err := ws.ReadMessage()
		if err != nil {
			break
		}
		if mt == websocket.BinaryMessage {
			p.handleFlacChunk(data)
			continue
		}
		if mt != websocket.TextMessage {
			continue
		}
		if !p.handle(data) {
			break
		}
	}
	p.close("socket closed")
}

func (p *Peer) pinger() {
	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-p.done:
			return
		case <-ticker.C:
			p.writeMu.Lock()
			err := p.ws.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second))
			p.writeMu.Unlock()
			if err != nil {
				go p.close("ping failed")
				return
			}
		}
	}
}

// handle processes one control frame. It returns false when the session should
// be closed (logout).
func (p *Peer) handle(data []byte) bool {
	var m clientMsg
	if err := json.Unmarshal(data, &m); err != nil {
		p.send(msgError{T: "error", Code: "bad_json", Message: "消息格式错误"})
		return true
	}
	switch m.T {
	case "join-room":
		p.enterRoom(m.Room, m.Password, false)
	case "create-room":
		p.enterRoom(m.Room, m.Password, true)
	case "leave-room":
		p.hub.leaveRoom(p, "user", true)
	case "offer":
		if p.room == nil {
			return true
		}
		if len(m.SDP) < 32 || len(m.SDP) > 60000 {
			p.send(msgError{T: "error", Code: "bad_sdp", Message: "SDP 无效"})
			return true
		}
		p.handleOffer(m.SDP, m.Fresh)
	case "answer":
		if p.room == nil {
			return true
		}
		if len(m.SDP) < 32 || len(m.SDP) > 60000 {
			return true
		}
		p.handleAnswer(m.SDP)
	case "candidate":
		if p.room != nil && m.Candidate != nil && len(m.Candidate.Candidate) < 512 {
			p.handleCandidate(*m.Candidate)
		}
	case "chat":
		if p.room == nil {
			p.send(msgError{T: "error", Code: "not_in_room", Message: "请先进入房间"})
			return true
		}
		text := strings.TrimSpace(m.Text)
		if text == "" {
			return true
		}
		if runes := []rune(text); len(runes) > 500 {
			text = string(runes[:500])
		}
		if !p.allowChat() {
			p.send(msgError{T: "error", Code: "chat_flood", Message: "发送太快了"})
			return true
		}
		msg := chatMessage{ID: newID(), From: p.name, FromID: p.id, Text: text, TS: nowMS()}
		p.hub.mu.Lock()
		p.room.Msgs = append(p.room.Msgs, msg)
		if len(p.room.Msgs) > 100 {
			p.room.Msgs = p.room.Msgs[len(p.room.Msgs)-100:]
		}
		p.hub.mu.Unlock()
		p.hub.broadcast(p.room, "", msgChat{T: "chat", Chat: msg})
	case "state":
		if m.Muted != nil {
			p.muted.Store(*m.Muted)
			if p.room != nil {
				p.hub.broadcast(p.room, "", msgPeerState{T: "peer-state", ID: p.id, Muted: *m.Muted})
			}
		}
	case "quality":
		p.bitrate.Store(int32(clamp(m.Bitrate, 24, p.hub.cfg.MaxBitrate)))
	case "flac-start":
		p.handleFlacStart(m)
	case "flac-stop":
		p.handleFlacStop()
	case "screen-start":
		p.handleScreenStart(m)
	case "screen-stop":
		p.handleScreenStop()
	case "ping":
		p.send(msgPong{T: "pong", TS: m.TS})
	case "logout":
		return false
	default:
		p.send(msgError{T: "error", Code: "unknown_type", Message: "未知消息类型"})
	}
	return true
}

// enterRoom joins an existing room or creates a new one, then sends the room
// snapshot and presence updates.
func (p *Peer) enterRoom(room, password string, create bool) {
	var joined *RoomJoined
	var err error
	if create {
		joined, err = p.hub.createRoom(p, room, password)
	} else {
		joined, err = p.hub.joinRoom(p, room, password)
	}
	if err != nil {
		code, message := "join_failed", "无法进入房间"
		if je, ok := err.(*joinError); ok {
			code, message = je.code, je.msg
		}
		p.send(msgError{T: "error", Code: code, Message: message})
		return
	}
	p.send(msgRoomJoined{
		T:         "room-joined",
		Room:      joined.Room,
		Self:      p.info(),
		Peers:     joined.Peers,
		History:   joined.History,
		FileToken: joined.FileToken,
		Files:     joined.Files,
		Screen:    joined.Screen,
	})
	p.hub.broadcast(p.room, p.id, msgPeerJoined{T: "peer-joined", Peer: p.info()})
	p.hub.broadcastRooms()
	p.log.Info("peer joined room", "id", p.id, "name", p.name, "room", joined.Room.Name)
}

func clientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			if first := strings.TrimSpace(strings.Split(xff, ",")[0]); first != "" {
				return first
			}
		}
		if real := strings.TrimSpace(r.Header.Get("X-Real-IP")); real != "" {
			return real
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func writeFrame(ws *websocket.Conn, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_ = ws.SetWriteDeadline(time.Now().Add(3 * time.Second))
	return ws.WriteMessage(websocket.TextMessage, b)
}
