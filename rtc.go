package main

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// source is the audio stream a single participant publishes. It survives
// renegotiation and a client-side PeerConnection rebuild, so subscribers keep
// their forwarding tracks.
type source struct {
	id       string
	kind     string // "audio" or "video"
	codec    webrtc.RTPCodecCapability
	keyFrame func()
	hub      *Hub

	mu     sync.RWMutex
	sinks  map[*sink]struct{}
	closed bool

	packets atomic.Uint64
	bytes   atomic.Uint64
}

func newSource(id string) *source {
	return &source{id: id, kind: "audio", codec: opusCapability(), sinks: make(map[*sink]struct{})}
}

func newVideoSource(id string, codec webrtc.RTPCodecCapability) *source {
	return &source{id: id, kind: "video", codec: codec, sinks: make(map[*sink]struct{})}
}

func (s *source) addSink(snk *sink) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return false
	}
	s.sinks[snk] = struct{}{}
	return true
}

func (s *source) removeSink(snk *sink) {
	s.mu.Lock()
	delete(s.sinks, snk)
	s.mu.Unlock()
}

// push fans one RTP packet out to every subscriber. Pion copies the packet
// header per binding, so sharing the pointer is safe. A full queue means the
// subscriber's socket is congested: drop instead of growing latency.
func (s *source) push(pkt *rtp.Packet) {
	s.packets.Add(1)
	s.bytes.Add(uint64(len(pkt.Payload)))

	s.mu.RLock()
	if s.closed {
		s.mu.RUnlock()
		return
	}
	var drops uint64
	for snk := range s.sinks {
		select {
		case snk.ch <- pkt:
		default:
			drops++
		}
	}
	forwarded := uint64(len(s.sinks)) - drops
	s.mu.RUnlock()
	if s.hub != nil {
		if drops > 0 {
			s.hub.drops.Add(drops)
		}
		s.hub.txPackets.Add(forwarded)
		s.hub.txBytes.Add(forwarded * uint64(len(pkt.Payload)))
	}
}

func (s *source) close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	sinks := make([]*sink, 0, len(s.sinks))
	for snk := range s.sinks {
		sinks = append(sinks, snk)
	}
	s.sinks = make(map[*sink]struct{})
	s.mu.Unlock()
	for _, snk := range sinks {
		snk.stop()
	}
}

// sink is one subscriber's forwarding track (publisher -> subscriber).
type sink struct {
	publisher string
	src       *source
	track     *webrtc.TrackLocalStaticRTP
	sender    *webrtc.RTPSender
	ch        chan *rtp.Packet
	stopCh    chan struct{}
	once      sync.Once
}

func newSink(src *source, track *webrtc.TrackLocalStaticRTP, sender *webrtc.RTPSender) *sink {
	return &sink{
		publisher: src.id,
		src:       src,
		track:     track,
		sender:    sender,
		ch:        make(chan *rtp.Packet, 8),
		stopCh:    make(chan struct{}),
	}
}

func (s *sink) run() {
	for {
		select {
		case pkt := <-s.ch:
			if err := s.track.WriteRTP(pkt); err != nil {
				return
			}
		case <-s.stopCh:
			return
		}
	}
}

func (s *sink) stop() {
	s.once.Do(func() { close(s.stopCh) })
}

func drainRTCP(sender *webrtc.RTPSender) {
	buf := make([]byte, 1500)
	for {
		if _, _, err := sender.Read(buf); err != nil {
			return
		}
	}
}

func opusCapability() webrtc.RTPCodecCapability {
	return webrtc.RTPCodecCapability{
		MimeType:    webrtc.MimeTypeOpus,
		ClockRate:   48000,
		Channels:    2,
		SDPFmtpLine: "minptime=10;useinbandfec=1",
	}
}

// handleOffer applies a client offer. The first offer of a session creates the
// connection; a later "fresh" offer means the client rebuilt its
// PeerConnection (for example after changing the quality profile).
func (p *Peer) handleOffer(sdp string, fresh bool) {
	p.pcMu.Lock()
	if p.closed.Load() || p.room == nil || p.source == nil {
		p.pcMu.Unlock()
		return
	}
	// A fresh client offer rebuilds the media connection (screen start/stop
	// or a quality change). Drop the previous screen source; a new video
	// track will create a new one if the offer carries one.
	p.closeVideoSource()
	p.teardownPCLocked()

	pc, err := p.hub.newPeerConnection(p)
	if err != nil {
		p.pcMu.Unlock()
		p.log.Error("create peer connection", "err", err)
		p.close("new peer connection failed")
		return
	}
	p.pc = pc
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: sdp}); err != nil {
		p.pcMu.Unlock()
		p.log.Warn("set remote offer", "err", err, "fresh", fresh)
		p.close("bad offer")
		return
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		p.pcMu.Unlock()
		p.log.Warn("create answer", "err", err)
		p.close("answer failed")
		return
	}
	// Pion validates SetLocalDescription(answer) against the SDP returned by
	// CreateAnswer, so the *patched* SDP must only be sent to the browser, not
	// installed locally. Installing it locally raises
	// "new sdp does not match previous answer" on browsers whose answer
	// contains an Opus fmtp line.
	patched := patchOpusSDP(answer.SDP, p.bitrateKbps())
	if err := pc.SetLocalDescription(answer); err != nil {
		p.pcMu.Unlock()
		p.log.Warn("set local answer", "err", err)
		p.close("answer failed")
		return
	}
	p.negotiating = true
	p.pcMu.Unlock()

	p.send(msgAnswer{T: "answer", SDP: patched})
	p.afterAnswer()
}

// handleAnswer applies the answer to a server-initiated offer and starts the
// next round if media changed in the meantime.
func (p *Peer) handleAnswer(sdp string) {
	p.pcMu.Lock()
	if p.pc == nil || p.closed.Load() {
		p.pcMu.Unlock()
		return
	}
	if err := p.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: sdp}); err != nil {
		p.pcMu.Unlock()
		p.log.Warn("set remote answer", "err", err)
		return
	}
	p.negotiating = false
	offer := ""
	if p.pendingOffer {
		p.pendingOffer = false
		offer = p.startOfferLocked()
	}
	p.pcMu.Unlock()
	if offer != "" {
		p.send(msgOffer{T: "offer", SDP: offer})
	}
}

func (p *Peer) handleCandidate(init webrtc.ICECandidateInit) {
	p.pcMu.Lock()
	defer p.pcMu.Unlock()
	if p.pc == nil {
		return
	}
	if err := p.pc.AddICECandidate(init); err != nil {
		p.log.Debug("add ice candidate", "err", err)
	}
}

// afterAnswer subscribes the peer to every existing publisher and triggers the
// follow-up offer that carries those receive tracks.
func (p *Peer) afterAnswer() {
	p.pcMu.Lock()
	if p.pc == nil || p.closed.Load() || p.room == nil {
		p.pcMu.Unlock()
		return
	}
	p.negotiating = false
	added := 0
	for _, other := range p.hub.peersExcept(p) {
		if other.closed.Load() {
			continue
		}
		if other.source != nil {
			if _, ok := p.sinks[other.id]; !ok {
				if err := p.addSinkLocked(other.source); err != nil {
					p.log.Debug("subscribe audio", "publisher", other.id, "err", err)
				} else {
					added++
				}
			}
		}
		if src := other.currentVideoSource(); src != nil {
			if _, ok := p.videoSinks[other.id]; !ok {
				if err := p.addSinkLocked(src); err != nil {
					p.log.Debug("subscribe video", "publisher", other.id, "err", err)
				} else {
					added++
				}
			}
		}
	}
	offer := ""
	if added > 0 {
		offer = p.startOfferLocked()
	}
	p.pcMu.Unlock()
	if offer != "" {
		p.send(msgOffer{T: "offer", SDP: offer})
	}
}

func (p *Peer) addSinkLocked(src *source) error {
	if p.pc == nil {
		return errors.New("no peer connection")
	}
	m := p.sinks
	if src.kind == "video" {
		m = p.videoSinks
	}
	if _, ok := m[src.id]; ok {
		return errors.New("already subscribed")
	}
	streamID := src.id
	trackID := "audio-" + src.id
	if src.kind == "video" {
		streamID = "screen-" + src.id
		trackID = "video-" + src.id
	}
	track, err := webrtc.NewTrackLocalStaticRTP(src.codec, trackID, streamID)
	if err != nil {
		return err
	}
	sender, err := p.pc.AddTrack(track)
	if err != nil {
		return err
	}
	snk := newSink(src, track, sender)
	if !src.addSink(snk) {
		_ = p.pc.RemoveTrack(sender)
		return errors.New("source closed")
	}
	m[src.id] = snk
	go snk.run()
	go drainRTCP(sender)
	if src.kind == "video" && src.keyFrame != nil {
		go src.keyFrame()
	}
	return nil
}

// subscribe adds a forwarding track for src and renegotiates once.
func (p *Peer) subscribe(src *source) {
	if src == nil || p.closed.Load() {
		return
	}
	p.pcMu.Lock()
	if p.pc == nil {
		p.pcMu.Unlock()
		return
	}
	m := p.sinks
	if src.kind == "video" {
		m = p.videoSinks
	}
	if _, ok := m[src.id]; ok {
		p.pcMu.Unlock()
		return
	}
	if err := p.addSinkLocked(src); err != nil {
		p.pcMu.Unlock()
		p.log.Debug("subscribe", "publisher", src.id, "kind", src.kind, "err", err)
		return
	}
	offer := p.startOfferLocked()
	p.pcMu.Unlock()
	if offer != "" {
		p.send(msgOffer{T: "offer", SDP: offer})
	}
}

func (p *Peer) removeSinkMap(kind, publisherID string) {
	p.pcMu.Lock()
	m := p.sinks
	if kind == "video" {
		m = p.videoSinks
	}
	snk, ok := m[publisherID]
	if !ok {
		p.pcMu.Unlock()
		return
	}
	delete(m, publisherID)
	snk.stop()
	if snk.src != nil {
		snk.src.removeSink(snk)
	}
	if p.pc != nil {
		if err := p.pc.RemoveTrack(snk.sender); err != nil {
			p.log.Debug("remove track", "kind", kind, "err", err)
		}
	}
	offer := p.startOfferLocked()
	p.pcMu.Unlock()
	if offer != "" {
		p.send(msgOffer{T: "offer", SDP: offer})
	}
}

func (p *Peer) removeSink(publisherID string) {
	p.removeSinkMap("audio", publisherID)
}

func (p *Peer) removeVideoSink(publisherID string) {
	p.removeSinkMap("video", publisherID)
}

// startOfferLocked must be called with pcMu held.
func (p *Peer) startOfferLocked() string {
	if p.pc == nil || p.closed.Load() {
		return ""
	}
	if p.negotiating {
		p.pendingOffer = true
		return ""
	}
	offer, err := p.pc.CreateOffer(nil)
	if err != nil {
		p.log.Warn("create offer", "err", err)
		return ""
	}
	if err := p.pc.SetLocalDescription(offer); err != nil {
		p.log.Warn("set local offer", "err", err)
		return ""
	}
	p.negotiating = true
	return offer.SDP
}

// readTrack pumps a publisher's RTP into its source. Header extensions are
// stripped because extension ids are negotiated per subscriber and may differ.
func (p *Peer) readTrack(track *webrtc.TrackRemote) {
	if track.Kind() == webrtc.RTPCodecTypeVideo {
		p.readVideoTrack(track)
		return
	}
	if p.source == nil {
		return
	}
	go p.hub.sourceWentLive(p)
	codec := track.Codec()
	p.log.Debug("publishing audio", "codec", codec.MimeType, "pt", codec.PayloadType,
		"channels", codec.Channels, "clock", codec.ClockRate)
	first := true
	for {
		pkt, _, err := track.ReadRTP()
		if err != nil {
			if !p.closed.Load() {
				p.log.Debug("publish stream ended", "err", err)
			}
			return
		}
		if p.closed.Load() || p.source == nil {
			return
		}
		if first {
			first = false
			p.log.Debug("first rtp packet", "seq", pkt.SequenceNumber, "bytes", len(pkt.Payload))
		}
		pkt.Header.Extension = false
		pkt.Header.ExtensionProfile = 0
		pkt.Header.Extensions = nil
		pkt.Header.CSRC = nil
		p.source.push(pkt)
	}
}

// readVideoTrack forwards one publisher's screen video RTP. It is created only
// while the peer is the active screen sharer in its room.
func (p *Peer) readVideoTrack(track *webrtc.TrackRemote) {
	codec := track.Codec()
	if codec.MimeType == "" {
		return
	}
	p.hub.mu.RLock()
	allowed := p.room != nil && p.room.Screen != nil && p.room.Screen.PeerID == p.id && !p.closed.Load()
	p.hub.mu.RUnlock()
	if !allowed {
		for {
			if _, _, err := track.ReadRTP(); err != nil {
				return
			}
		}
	}
	src := newVideoSource(p.id, webrtc.RTPCodecCapability{
		MimeType:    codec.MimeType,
		ClockRate:   codec.ClockRate,
		Channels:    codec.Channels,
		SDPFmtpLine: codec.SDPFmtpLine,
	})
	ssrc := uint32(track.SSRC())
	src.keyFrame = func() {
		p.pcMu.Lock()
		pc := p.pc
		p.pcMu.Unlock()
		if pc == nil {
			return
		}
		_ = pc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: ssrc}})
	}
	p.setVideoSource(src)
	go p.hub.videoWentLive(p, src)
	p.log.Debug("publishing screen video", "codec", codec.MimeType, "pt", codec.PayloadType, "clock", codec.ClockRate)
	first := true
	for {
		pkt, _, err := track.ReadRTP()
		if err != nil {
			if !p.closed.Load() {
				p.log.Debug("screen stream ended", "err", err)
			}
			return
		}
		if p.closed.Load() {
			return
		}
		if first {
			first = false
			p.log.Debug("first screen rtp packet", "seq", pkt.SequenceNumber, "bytes", len(pkt.Payload))
		}
		pkt.Header.Extension = false
		pkt.Header.ExtensionProfile = 0
		pkt.Header.Extensions = nil
		pkt.Header.CSRC = nil
		src.push(pkt)
	}
}

func (p *Peer) setVideoSource(src *source) {
	p.videoMu.Lock()
	old := p.videoSource
	p.videoSource = src
	p.videoMu.Unlock()
	if old != nil && old != src {
		old.close()
	}
}

func (p *Peer) currentVideoSource() *source {
	p.videoMu.Lock()
	defer p.videoMu.Unlock()
	return p.videoSource
}

func (p *Peer) closeVideoSource() {
	p.videoMu.Lock()
	src := p.videoSource
	p.videoSource = nil
	p.videoMu.Unlock()
	if src != nil {
		src.close()
	}
}

// videoWentLive makes every other participant subscribe to a new screen stream.
func (h *Hub) videoWentLive(p *Peer, src *source) {
	if src == nil {
		return
	}
	for _, other := range h.peersExcept(p) {
		other.subscribe(src)
	}
}

// patchOpusSDP rewrites the Opus fmtp line so both browsers and the SFU agree
// on a high-quality, low-latency configuration. The bitrate in an SDP answer is
// what Chrome uses to configure its Opus encoder.
func patchOpusSDP(sdp string, kbps int) string {
	sep := "\r\n"
	if !strings.Contains(sdp, sep) {
		sep = "\n"
	}
	lines := strings.Split(sdp, sep)
	pt := ""
	rtpIdx := -1
	for i, line := range lines {
		if strings.HasPrefix(line, "a=rtpmap:") && strings.Contains(strings.ToLower(line), "opus/48000") {
			rest := strings.TrimPrefix(line, "a=rtpmap:")
			if sp := strings.IndexByte(rest, ' '); sp > 0 {
				pt = rest[:sp]
				rtpIdx = i
				break
			}
		}
	}
	if pt == "" {
		return sdp
	}
	if kbps < 24 {
		kbps = 24
	}
	if kbps > 510 {
		kbps = 510
	}
	stereo := "0"
	if kbps >= 96 {
		stereo = "1"
	}
	fmtp := fmt.Sprintf("a=fmtp:%s minptime=10;useinbandfec=1;usedtx=0;stereo=%s;sprop-stereo=%s;maxplaybackrate=48000;maxaveragebitrate=%d",
		pt, stereo, stereo, kbps*1000)

	prefix := "a=fmtp:" + pt + " "
	for i, line := range lines {
		if strings.HasPrefix(line, prefix) {
			lines[i] = fmtp
			return strings.Join(lines, sep)
		}
	}
	lines = append(lines[:rtpIdx+1], append([]string{fmtp}, lines[rtpIdx+1:]...)...)
	return strings.Join(lines, sep)
}
