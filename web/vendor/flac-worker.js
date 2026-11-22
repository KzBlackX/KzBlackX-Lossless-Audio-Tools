// Encodes one standalone FLAC stream per PCM chunk using libFLAC compiled to
// WASM. Receivers decode these chunks with the browser's native FLAC decoder,
// so no decoder has to be shipped to them.
importScripts('libflac.min.wasm.js');

let readyResolve;
const ready = new Promise((resolve) => { readyResolve = resolve; });
if (Flac.isReady()) readyResolve();
else Flac.on('ready', readyResolve);

self.onmessage = async (event) => {
  const { seq, pcm, sampleRate, channels, bits } = event.data;
  try {
    await ready;
    const frames = pcm.length / channels;
    const encoder = Flac.create_libflac_encoder(sampleRate, channels, bits, 5, frames, false, 0);
    if (!encoder) throw new Error('FLAC encoder init failed');

    const parts = [];
    const status = Flac.init_encoder_stream(
      encoder,
      (data, bytes) => { parts.push(data.slice(0, bytes)); },
      () => {},
    );
    if (status !== 0) throw new Error('FLAC stream init failed: ' + status);

    const samples = new Int32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i];
    const ok = Flac.FLAC__stream_encoder_process_interleaved(encoder, samples, frames);
    const finished = Flac.FLAC__stream_encoder_finish(encoder);
    Flac.FLAC__stream_encoder_delete(encoder);
    if (!ok || !finished) throw new Error('FLAC encode failed');

    let total = 0;
    for (const part of parts) total += part.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.length; }
    self.postMessage({ seq, bytes: total, flac: out.buffer }, [out.buffer]);
  } catch (err) {
    self.postMessage({ seq, error: String(err && err.message ? err.message : err) });
  }
};
