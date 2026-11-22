// VoiceLink wraps the browser side of the SFU connection.
// One RTCPeerConnection carries our microphone up and everybody else's audio
// down. The server renegotiates when participants join or leave.

export const QUALITY = {
  voice: {
    id: 'voice', name: '语音', kbps: 32, stereo: false,
    ec: true, ns: true, agc: true, desc: '32k · 省流',
  },
  standard: {
    id: 'standard', name: '标准', kbps: 96, stereo: false,
    ec: true, ns: true, agc: true, desc: '96k · 语音',
  },
  music: {
    id: 'music', name: '音乐', kbps: 192, stereo: true,
    ec: false, ns: false, agc: false, desc: '192k · 立体声',
  },
  studio: {
    id: 'studio', name: '录音室', kbps: 320, stereo: true,
    ec: false, ns: false, agc: false, desc: '320k · 高保真',
  },
};

const OPUS_PARAMS = (kbps) => {
  const stereo = kbps >= 96 ? 1 : 0;
  return [
    'minptime=10',
    'useinbandfec=1',
    'usedtx=0',
    `stereo=${stereo}`,
    `sprop-stereo=${stereo}`,
    'maxplaybackrate=48000',
    `maxaveragebitrate=${Math.round(kbps * 1000)}`,
  ].join(';');
};

// preferOpus rewrites the fmtp line for the Opus payload type. Chrome uses
// maxaveragebitrate from the negotiated SDP to size its encoder.
export function preferOpus(sdp, kbps) {
  const sep = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(sep);
  let pt = null;
  let rtpmapAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = /^a=rtpmap:(\d+)\s+opus\/48000/i.exec(lines[i]);
    if (m) {
      pt = m[1];
      rtpmapAt = i;
      break;
    }
  }
  if (!pt) return sdp;
  const fmtp = `a=fmtp:${pt} ${OPUS_PARAMS(kbps)}`;
  const prefix = `a=fmtp:${pt} `;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(prefix)) {
      lines[i] = fmtp;
      return lines.join(sep);
    }
  }
  lines.splice(rtpmapAt + 1, 0, fmtp);
  return lines.join(sep);
}

function opusOnly() {
  try {
    const caps = RTCRtpSender.getCapabilities('audio');
    if (!caps) return null;
    const opus = caps.codecs.filter((c) => c.mimeType.toLowerCase() === 'audio/opus');
    return opus.length ? opus : null;
  } catch {
    return null;
  }
}

export class VoiceLink {
  constructor({ onSignal, onTrack, onState, onLog }) {
    this.onSignal = onSignal;
    this.onTrack = onTrack;
    this.onState = onState;
    this.onLog = onLog || (() => {});
    this.pc = null;
    this.stream = null;
    this.kbps = 96;
    this.chain = Promise.resolve();
    this.pendingRemoteCandidates = [];
    this.remoteReady = false;
    this.closed = false;
    this.prev = new Map();
    this.lastStatsAt = 0;
    this.tracks = new Map(); // peerId -> MediaStreamTrack
    this.midMap = new Map(); // transceiver mid -> peerId
  }

  get localTrack() {
    return this.stream ? this.stream.getAudioTracks()[0] || null : null;
  }

  async start(stream, kbps) {
    this.stream = stream;
    this.kbps = kbps;
    await this.build(false);
  }

  async rebuild(stream, kbps) {
    this.stream = stream;
    this.kbps = kbps;
    await this.build(true);
  }

  async build(fresh) {
    this.teardownPC();
    this.closed = false;
    this.remoteReady = false;
    this.pendingRemoteCandidates = [];

    const pc = new RTCPeerConnection({
      iceServers: [],
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 0,
    });
    this.pc = pc;

    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.onSignal({ t: 'candidate', candidate: ev.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      this.onState(pc.connectionState);
    };
    pc.oniceconnectionstatechange = () => {
      if (this.pc !== pc) return;
      if (pc.iceConnectionState === 'failed') this.onState('failed');
    };
    pc.ontrack = (ev) => {
      const track = ev.track;
      if (track.kind !== 'audio') return;
      const stream = ev.streams && ev.streams[0] ? ev.streams[0] : new MediaStream([track]);
      const peerId = stream.id || track.id.replace(/^audio-/, '');
      this.tracks.set(peerId, track);
      const mid = ev.transceiver && ev.transceiver.mid;
      if (mid != null) this.midMap.set(String(mid), peerId);
      try {
        const receiver = ev.receiver;
        if (receiver && 'playoutDelayHint' in receiver) receiver.playoutDelayHint = 0;
      } catch { /* optional */ }
      this.onTrack(peerId, stream, track);
    };

    let transceiver;
    if (this.localTrack) {
      transceiver = pc.addTransceiver(this.localTrack, {
        direction: 'sendrecv',
        streams: [this.stream],
      });
    } else {
      transceiver = pc.addTransceiver('audio', { direction: 'recvonly' });
    }
    const codecs = opusOnly();
    if (codecs && transceiver.setCodecPreferences) {
      try { transceiver.setCodecPreferences(codecs); } catch (e) { this.onLog('codec prefs: ' + e.message); }
    }

    const offer = await pc.createOffer();
    const sdp = preferOpus(offer.sdp, this.kbps);
    await pc.setLocalDescription({ type: 'offer', sdp });
    this.onSignal({ t: 'offer', sdp, fresh });
  }

  handleOffer(sdp) {
    this.enqueue(async () => {
      if (!this.pc || this.closed) return;
      if (this.pc.signalingState === 'have-local-offer') {
        this.onLog('ignoring stale offer during renegotiation');
        return;
      }
      await this.pc.setRemoteDescription({ type: 'offer', sdp });
      this.remoteReady = true;
      await this.flushCandidates();
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.onSignal({ t: 'answer', sdp: answer.sdp });
    });
  }

  handleAnswer(sdp) {
    this.enqueue(async () => {
      if (!this.pc || this.closed) return;
      if (this.pc.signalingState !== 'have-local-offer') {
        this.onLog('ignoring stale answer (state ' + this.pc.signalingState + ')');
        return;
      }
      await this.pc.setRemoteDescription({ type: 'answer', sdp });
      this.remoteReady = true;
      await this.flushCandidates();
    });
  }

  handleCandidate(init) {
    if (!init || !this.pc) return;
    if (!this.remoteReady) {
      this.pendingRemoteCandidates.push(init);
      return;
    }
    this.pc.addIceCandidate(init).catch((e) => this.onLog('ice: ' + e.message));
  }

  async flushCandidates() {
    const queued = this.pendingRemoteCandidates;
    this.pendingRemoteCandidates = [];
    for (const c of queued) {
      try { await this.pc.addIceCandidate(c); } catch (e) { this.onLog('ice queued: ' + e.message); }
    }
  }

  enqueue(fn) {
    this.chain = this.chain.then(fn).catch((e) => this.onLog('sdp: ' + e.message));
    return this.chain;
  }

  setMicEnabled(enabled) {
    const track = this.localTrack;
    if (track) track.enabled = enabled;
  }

  teardownPC() {
    if (this.pc) {
      try { this.pc.onicecandidate = null; this.pc.ontrack = null; } catch { /* noop */ }
      try { this.pc.close(); } catch { /* noop */ }
      this.pc = null;
    }
    this.tracks.clear();
    this.midMap.clear();
    this.prev.clear();
  }

  close() {
    this.closed = true;
    this.teardownPC();
  }

  // stats returns a snapshot with per-peer inbound numbers derived from deltas.
  async stats() {
    if (!this.pc) return null;
    let report;
    try { report = await this.pc.getStats(); } catch { return null; }
    const now = performance.now();
    const dt = this.lastStatsAt ? (now - this.lastStatsAt) / 1000 : 0;
    this.lastStatsAt = now;

    const out = { peers: [], rtt: null, jitter: null, lossPct: null, inKbps: 0, outKbps: 0, limitation: '' };
    const seen = new Set();

    report.forEach((r) => {
      if (r.type === 'inbound-rtp' && (r.kind === 'audio' || r.mediaType === 'audio')) {
        seen.add(r.id);
        const prev = this.prev.get(r.id);
        const bytes = r.bytesReceived || 0;
        const kbps = prev && dt > 0 ? ((bytes - prev.bytes) * 8) / 1000 / dt : 0;
        this.prev.set(r.id, { bytes });
        const peerId = this.midMap.get(String(r.mid)) || (r.trackIdentifier || '').replace(/^audio-/, '');
        const lost = r.packetsLost || 0;
        out.peers.push({
          peerId,
          kbps: Math.max(0, Math.round(kbps)),
          jitter: r.jitter || 0,
          packetsLost: lost,
          lossPct: r.fractionLost != null ? r.fractionLost * 100 : null,
          codec: r.codecId || '',
        });
        out.inKbps += Math.max(0, kbps);
        if (r.jitter != null) out.jitter = Math.max(out.jitter || 0, r.jitter);
      } else if (r.type === 'outbound-rtp' && (r.kind === 'audio' || r.mediaType === 'audio')) {
        const prev = this.prev.get(r.id);
        const bytes = r.bytesSent || 0;
        if (prev && dt > 0) out.outKbps = Math.max(0, ((bytes - prev.bytes) * 8) / 1000 / dt);
        this.prev.set(r.id, { bytes });
        seen.add(r.id);
        if (r.qualityLimitationReason) out.limitation = r.qualityLimitationReason;
        if (r.targetBitrate) out.targetKbps = Math.round(r.targetBitrate / 1000);
      } else if (r.type === 'remote-inbound-rtp' && (r.kind === 'audio' || r.mediaType === 'audio')) {
        seen.add(r.id);
        if (r.roundTripTime != null) out.rtt = r.roundTripTime * 1000;
        if (r.fractionLost != null) out.lossPct = r.fractionLost * 100;
      } else if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) {
        if (r.currentRoundTripTime != null) out.rtt = r.currentRoundTripTime * 1000;
      }
    });
    for (const key of [...this.prev.keys()]) {
      if (!seen.has(key)) this.prev.delete(key);
    }
    out.peers.sort((a, b) => b.kbps - a.kbps);
    return out;
  }
}
