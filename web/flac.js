// FLAC lossless side channel.
//
// Sender: capture raw PCM -> 500 ms chunks -> libFLAC (WASM, in a worker) ->
// standalone FLAC streams over the WebSocket.
// Receiver: native decodeAudioData() -> AudioBufferSourceNode scheduled with a
// small jitter buffer. No decoder WASM is needed on the receiving side.

const CHUNK_MS = 500;

export class FlacSender {
  constructor({ deviceId = '', stream = null, onChunk, onError, onLog } = {}) {
    this.deviceId = deviceId;
    this.sharedStream = stream;
    this.ownsStream = !stream;
    this.onChunk = onChunk || (() => {});
    this.onError = onError || (() => {});
    this.onLog = onLog || (() => {});
    this.stream = null;
    this.ctx = null;
    this.source = null;
    this.processor = null;
    this.worker = null;
    this.seq = 0;
    this.filled = 0;
    this.chunkFrames = 0;
    this.channels = 1;
    this.sampleRate = 48000;
    this.buffers = [];
    this.running = false;
  }

  async start() {
    const constraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 2 },
      sampleRate: { ideal: 48000 },
    };
    if (this.deviceId) constraints.deviceId = { exact: this.deviceId };

    if (this.sharedStream) {
      this.stream = this.sharedStream;
    } else {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
      } catch (err) {
        // The selected device may have disappeared; fall back to the default one.
        if (constraints.deviceId) {
          delete constraints.deviceId;
          this.stream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
        } else {
          throw err;
        }
      }
    }

    const track = this.stream.getAudioTracks()[0];
    this.sampleRate = 48000;
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    if (this.ctx.sampleRate) this.sampleRate = this.ctx.sampleRate;
    await this.ctx.resume();

    const settings = track.getSettings ? track.getSettings() : {};
    this.channels = Math.min(2, Math.max(1, settings.channelCount || 1));
    this.chunkFrames = Math.max(4096, Math.round((this.sampleRate * CHUNK_MS) / 1000));
    this.buffers = Array.from({ length: this.channels }, () => new Float32Array(this.chunkFrames));
    this.filled = 0;

    this.worker = new Worker('/vendor/flac-worker.js');
    this.worker.onmessage = (event) => {
      const data = event.data || {};
      if (data.error) {
        this.onError(new Error(data.error));
        return;
      }
      if (data.flac) this.onChunk(new Uint8Array(data.flac), data.bytes);
    };
    this.worker.onerror = (event) => this.onError(new Error(event.message || 'FLAC worker failed'));

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.processor = this.ctx.createScriptProcessor(4096, this.channels, this.channels);
    const sink = this.ctx.createGain();
    sink.gain.value = 0; // keep the graph alive without monitoring ourselves
    this.source.connect(this.processor);
    this.processor.connect(sink);
    sink.connect(this.ctx.destination);
    this.processor.onaudioprocess = (event) => this.capture(event.inputBuffer);
    this.running = true;

    return {
      sampleRate: this.sampleRate,
      channels: this.channels,
      bits: 16,
      chunkMs: CHUNK_MS,
    };
  }

  capture(input) {
    if (!this.running) return;
    const frames = input.length;
    const channels = Math.min(this.channels, input.numberOfChannels);
    let offset = 0;
    while (offset < frames) {
      const room = this.chunkFrames - this.filled;
      const take = Math.min(room, frames - offset);
      for (let ch = 0; ch < this.channels; ch++) {
        const srcCh = Math.min(ch, channels - 1);
        const data = input.getChannelData(srcCh);
        this.buffers[ch].set(data.subarray(offset, offset + take), this.filled);
      }
      this.filled += take;
      offset += take;
      if (this.filled >= this.chunkFrames) this.encodeChunk();
    }
  }

  encodeChunk() {
    if (!this.worker) return;
    const frames = this.chunkFrames;
    const pcm = new Int16Array(frames * this.channels);
    for (let i = 0; i < frames; i++) {
      for (let ch = 0; ch < this.channels; ch++) {
        let v = this.buffers[ch][i];
        if (v > 1) v = 1; else if (v < -1) v = -1;
        pcm[i * this.channels + ch] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
      }
    }
    this.filled = 0;
    this.seq++;
    this.worker.postMessage({
      seq: this.seq,
      pcm,
      sampleRate: this.sampleRate,
      channels: this.channels,
      bits: 16,
    }, [pcm.buffer]);
  }

  stop() {
    this.running = false;
    if (this.processor) {
      this.processor.onaudioprocess = null;
      try { this.processor.disconnect(); } catch { /* noop */ }
      this.processor = null;
    }
    if (this.source) {
      try { this.source.disconnect(); } catch { /* noop */ }
      this.source = null;
    }
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    if (this.stream && this.ownsStream) {
      for (const track of this.stream.getTracks()) track.stop();
    }
    this.stream = null;
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}

export class FlacPlayer {
  constructor({ sampleRate = 48000, onError } = {}) {
    this.onError = onError || (() => {});
    this.ctx = null;
    try {
      this.ctx = new AudioContext({ sampleRate, latencyHint: 'interactive' });
    } catch {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
    }
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 1;
    this.gain.connect(this.ctx.destination);
    this.chain = Promise.resolve();
    this.nextTime = 0;
    this.chunks = 0;
    this.bytes = 0;
    this.failed = 0;
    this.ctx.resume().catch(() => {});
  }

  push(buffer) {
    if (!this.ctx) return;
    this.bytes += buffer.byteLength;
    this.chain = this.chain.then(async () => {
      if (!this.ctx) return;
      try {
        if (this.ctx.state === 'suspended') await this.ctx.resume();
        const audio = await this.ctx.decodeAudioData(buffer);
        const now = this.ctx.currentTime;
        if (!this.nextTime || this.nextTime < now + 0.08 || this.nextTime > now + 2) {
          this.nextTime = now + 0.35;
        }
        const src = this.ctx.createBufferSource();
        src.buffer = audio;
        src.connect(this.gain);
        src.start(this.nextTime);
        this.nextTime += audio.duration;
        this.chunks++;
      } catch (err) {
        this.failed++;
        this.onError(err);
      }
    }).catch((err) => this.onError(err));
  }

  setVolume(value) {
    if (!this.ctx) return;
    const v = Math.max(0, Math.min(1.5, value));
    this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }

  stats() {
    return {
      chunks: this.chunks,
      bytes: this.bytes,
      failed: this.failed,
      sampleRate: this.ctx?.sampleRate || 0,
      state: this.ctx?.state || 'closed',
    };
  }

  close() {
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}

export { CHUNK_MS };
