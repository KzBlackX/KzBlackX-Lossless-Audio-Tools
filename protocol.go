package main

import (
	"time"

	"github.com/pion/webrtc/v4"
)

// Wire protocol shared with web/app.js. Every frame is a JSON object with a
// "t" (type) discriminator.

type clientMsg struct {
	T         string                   `json:"t"`
	Room      string                   `json:"room,omitempty"`
	Name      string                   `json:"name,omitempty"`
	Password  string                   `json:"password,omitempty"`
	Bitrate   int                      `json:"bitrate,omitempty"`
	SDP       string                   `json:"sdp,omitempty"`
	Fresh     bool                     `json:"fresh,omitempty"`
	Candidate *webrtc.ICECandidateInit `json:"candidate,omitempty"`
	Text      string                   `json:"text,omitempty"`
	Muted     *bool                    `json:"muted,omitempty"`
	TS        int64                    `json:"ts,omitempty"`

	// FLAC lossless side channel (one active sender per room).
	SampleRate int `json:"sampleRate,omitempty"`
	Channels   int `json:"channels,omitempty"`
	Bits       int `json:"bits,omitempty"`
	ChunkMS    int `json:"chunkMs,omitempty"`

	// Screen sharing metadata (frames travel over HTTP).
	Width         int `json:"width,omitempty"`
	Height        int `json:"height,omitempty"`
	FPS           int `json:"fps,omitempty"`
	ScreenBitrate int `json:"screenBitrate,omitempty"`
}

type peerInfo struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Muted    bool   `json:"muted"`
	JoinedAt int64  `json:"joinedAt"`
}

type roomInfo struct {
	Name      string `json:"name"`
	Count     int    `json:"count"`
	Permanent bool   `json:"permanent"`
	Locked    bool   `json:"locked"`
}

type chatMessage struct {
	ID     string `json:"id"`
	From   string `json:"from"`
	FromID string `json:"fromId"`
	Text   string `json:"text"`
	TS     int64  `json:"ts"`
	System bool   `json:"system,omitempty"`
}

type settingsInfo struct {
	Version        string `json:"version"`
	ServerName     string `json:"serverName"`
	MaxBitrate     int    `json:"maxBitrate"`
	DefaultBitrate int    `json:"defaultBitrate"`
	MaxRoom        int    `json:"maxRoom"`
	MaxRooms       int    `json:"maxRooms"`
	UDPPort        int    `json:"udpPort"`
	RequiresPass   bool   `json:"requiresPassword"`
	MaxFileMB      int    `json:"maxFileMB"`
}

type msgWelcome struct {
	T        string       `json:"t"`
	Self     peerInfo     `json:"self"`
	Rooms    []roomInfo   `json:"rooms"`
	Settings settingsInfo `json:"settings"`
	Token    string       `json:"token"`
}

type msgRoomJoined struct {
	T         string        `json:"t"`
	Room      roomInfo      `json:"room"`
	Self      peerInfo      `json:"self"`
	Peers     []peerInfo    `json:"peers"`
	History   []chatMessage `json:"history"`
	FileToken string        `json:"fileToken"`
	Files     []fileInfo    `json:"files"`
	Screen    *screenInfo   `json:"screen,omitempty"`
}

type fileInfo struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	MIME   string `json:"mime"`
	From   string `json:"from"`
	FromID string `json:"fromId"`
	TS     int64  `json:"ts"`
}

type msgFileShared struct {
	T    string   `json:"t"`
	File fileInfo `json:"file"`
}

type msgFileRemoved struct {
	T  string `json:"t"`
	ID string `json:"id"`
}

type screenInfo struct {
	Peer    peerInfo `json:"peer"`
	Width   int      `json:"width"`
	Height  int      `json:"height"`
	FPS     int      `json:"fps"`
	Bitrate int      `json:"bitrate"`
}

type msgScreenStarted struct {
	T      string     `json:"t"`
	Screen screenInfo `json:"screen"`
}

type msgScreenStopped struct {
	T      string `json:"t"`
	ID     string `json:"id"`
	Reason string `json:"reason,omitempty"`
}

type msgRoomLeft struct {
	T      string `json:"t"`
	Room   string `json:"room"`
	Reason string `json:"reason,omitempty"`
}

type msgPeerJoined struct {
	T    string   `json:"t"`
	Peer peerInfo `json:"peer"`
}

type msgPeerLeft struct {
	T  string `json:"t"`
	ID string `json:"id"`
}

type msgPeerState struct {
	T     string `json:"t"`
	ID    string `json:"id"`
	Muted bool   `json:"muted"`
}

type msgChat struct {
	T    string      `json:"t"`
	Chat chatMessage `json:"chat"`
}

type msgRooms struct {
	T     string     `json:"t"`
	Rooms []roomInfo `json:"rooms"`
}

type msgOffer struct {
	T   string `json:"t"`
	SDP string `json:"sdp"`
}

type msgAnswer struct {
	T   string `json:"t"`
	SDP string `json:"sdp"`
}

type msgCandidate struct {
	T         string                   `json:"t"`
	Candidate *webrtc.ICECandidateInit `json:"candidate"`
}

type msgError struct {
	T       string `json:"t"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type msgFlacStarted struct {
	T          string   `json:"t"`
	Peer       peerInfo `json:"peer"`
	SampleRate int      `json:"sampleRate"`
	Channels   int      `json:"channels"`
	Bits       int      `json:"bits"`
	ChunkMS    int      `json:"chunkMs"`
}

type msgFlacStopped struct {
	T      string `json:"t"`
	ID     string `json:"id"`
	Reason string `json:"reason,omitempty"`
}

type msgPong struct {
	T  string `json:"t"`
	TS int64  `json:"ts"`
}

type msgStats struct {
	T          string  `json:"t"`
	RSSBytes   int64   `json:"rssBytes"`
	CPU        float64 `json:"cpu"`
	Uptime     int64   `json:"uptime"`
	Goroutines int     `json:"goroutines"`
	Peers      int     `json:"peers"`
	InRooms    int     `json:"inRooms"`
	Rooms      int     `json:"rooms"`
	TxPackets  uint64  `json:"txPackets"`
	TxBytes    uint64  `json:"txBytes"`
	Drops      uint64  `json:"drops"`
}

func nowMS() int64 { return time.Now().UnixMilli() }
