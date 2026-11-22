// End-to-end check: two headless Chromium clients join the same room, exchange
// audio and chat, mute, and leave. Run against a local server:
//
//   QY_BASE=http://127.0.0.1:8080 QY_PASSWORD=test123 node e2e.mjs
//
// Requires: npm install && npx playwright install chromium
import { chromium } from 'playwright';

const BASE = process.env.QY_BASE || 'http://127.0.0.1:8080';
const PASSWORD = process.env.QY_PASSWORD || '';
const ROOM = process.env.QY_ROOM || '大厅';
const HEADLESS = process.env.QY_HEADFUL !== '1';

function assert(cond, message) {
  if (!cond) throw new Error('assertion failed: ' + message);
}

const browser = await chromium.launch({
  headless: HEADLESS,
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--no-sandbox',
  ],
});

const errors = [];
async function openClient(name) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await ctx.grantPermissions(['microphone'], { origin: BASE });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${name}: ${m.text()}`);
  });
  await page.goto(`${BASE}/`);
  await page.waitForFunction(() => window.__QY_READY === true, null, { timeout: 15000 });
  await page.fill('#name', name);
  if (PASSWORD) await page.fill('#password', PASSWORD);
  await page.click('#login-btn');
  await page.waitForFunction(() => window.qy?.loggedIn === true, null, { timeout: 25000 });
  // First click asks for confirmation; the second click enters.
  for (let i = 0; i < 2; i++) {
    await page.evaluate((room) => {
      const item = [...document.querySelectorAll('#channel-list .channel')]
        .find((el) => el.textContent.includes(room));
      if (!item) throw new Error('room not found: ' + room);
      item.click();
    }, ROOM);
    await page.waitForTimeout(200);
  }
  await page.waitForFunction((room) => window.qy?.joined === true && window.qy?.room === room,
    ROOM, { timeout: 25000 });
  return page;
}

async function waitForAudio(page, label) {
  await page.waitForFunction(() => {
    const peer = window.qy?.peers?.[0];
    return window.qy?.peers?.length === 1 && peer.audio?.readyState === 4 && peer.stream;
  }, null, { timeout: 20000 });
  let last = null;
  for (let i = 0; i < 20; i++) {
    last = await page.evaluate(() => window.qy.stats());
    const kbps = last?.peers?.[0]?.kbps || 0;
    if (kbps > 10) return { first: null, second: last };
    await page.waitForTimeout(500);
  }
  assert(false, `${label}: inbound audio bitrate stayed at ${last?.peers?.[0]?.kbps ?? 0} kbps`);
}

try {
  const a = await openClient('测试 A');
  const b = await openClient('测试 B');
  await a.waitForFunction(() => window.qy.peers.length === 1, null, { timeout: 20000 });
  const statsA = await waitForAudio(a, 'A');
  const statsB = await waitForAudio(b, 'B');
  console.log('audio A', statsA.second.peers[0], '\naudio B', statsB.second.peers[0]);

  await b.fill('#chat-input', '你好，听得见吗');
  await b.press('#chat-input', 'Enter');
  await a.waitForFunction(() => document.getElementById('chat-log').innerText.includes('你好，听得见吗'), null, { timeout: 10000 });
  console.log('chat ok');

  // File transfer: A uploads through the HTTP endpoint, both see the card,
  // and the room-token download returns the exact bytes.
  await a.setInputFiles('#file-input', {
    name: 'e2e-check.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('KzBlackX file transfer\n'),
  });
  await a.waitForFunction(() => window.qy.app.files.some((f) => f.name === 'e2e-check.txt'), null, { timeout: 20000 });
  await b.waitForFunction(() => window.qy.app.files.some((f) => f.name === 'e2e-check.txt'), null, { timeout: 20000 });
  const fileHref = await a.evaluate(() => document.querySelector('#file-list .file-card').href);
  const fileRes = await a.request.get(fileHref);
  assert(fileRes.ok(), 'file download failed: HTTP ' + fileRes.status());
  assert((await fileRes.text()) === 'KzBlackX file transfer\n', 'file bytes changed in transit');
  console.log('file transfer ok');

  // Screen sharing: use a canvas capture stream as a deterministic screen
  // track, start the share through the normal UI, and verify the second client
  // receives a decoded WebRTC video track.
  await a.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 960; canvas.height = 540;
    const ctx = canvas.getContext('2d');
    const draw = () => {
      ctx.fillStyle = '#0b3d2e'; ctx.fillRect(0, 0, 960, 540);
      ctx.fillStyle = '#6ee7b7'; ctx.font = 'bold 48px sans-serif';
      ctx.fillText('KzBlackX WebRTC screen', 70, 250);
      ctx.fillStyle = '#9fb4c7'; ctx.font = '22px monospace';
      ctx.fillText('canvas capture -> VP8 -> Pion -> viewer', 72, 300);
    };
    draw();
    setInterval(draw, 100);
    const stream = canvas.captureStream(10);
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      configurable: true,
      value: async () => stream,
    });
  });
  await a.click('#screen-btn');
  await a.waitForTimeout(250);
  await a.click('#screen-start');
  await a.waitForFunction(() => window.qy.app.screen.owner && window.qy.app.screen.info, null, { timeout: 25000 });
  await b.waitForFunction(() => window.qy.app.screen.active && !window.qy.app.screen.owner
    && document.getElementById('screen-video').videoWidth > 0, null, { timeout: 25000 });
  const screenMeta = await b.evaluate(() => ({
    width: document.getElementById('screen-video').videoWidth,
    height: document.getElementById('screen-video').videoHeight,
    info: window.qy.app.screen.info,
  }));
  assert(screenMeta.width > 0 && screenMeta.height > 0, 'screen video track did not decode');
  await a.click('#screen-stop');
  await b.waitForFunction(() => !window.qy.app.screen.active, null, { timeout: 10000 });
  console.log('screen WebRTC ok:', screenMeta.width + 'x' + screenMeta.height);

  await b.evaluate(() => window.qy.setMuted(true));
  await a.waitForTimeout(2500);
  const statsMuted = await a.evaluate(() => window.qy.stats());
  const mutedKbps = statsMuted?.peers?.[0]?.kbps ?? 0;
  console.log('A inbound while B muted:', mutedKbps, 'kbps');
  await b.evaluate(() => window.qy.setMuted(false));

  // FLAC lossless side channel: A encodes, B decodes.
  await a.evaluate(() => window.qy.startFlac());
  await b.waitForFunction(() => (window.qy.flac?.player?.chunks || 0) > 0, null, { timeout: 25000 });
  await b.waitForTimeout(1200);
  const flac = await b.evaluate(() => window.qy.flac);
  assert(flac.player && flac.player.bytes > 0 && flac.player.chunks > 0, 'FLAC chunks did not decode');
  console.log('FLAC ok:', flac.player.chunks, 'chunks,', flac.player.bytes, 'bytes');
  await a.evaluate(() => window.qy.stopFlac());
  await b.waitForFunction(() => !window.qy.flac.active, null, { timeout: 10000 });

  await b.close();
  await a.waitForFunction(() => window.qy.peers.length === 0, null, { timeout: 20000 });
  console.log('peer-left ok');

  // Leaving returns to the login page and closes the session.
  await a.click('#leave-btn');
  await a.waitForFunction(() => window.qy.loggedIn === false
    && !document.getElementById('login').classList.contains('hidden'), null, { timeout: 10000 });
  console.log('leave -> login ok');

  assert(errors.length === 0, 'console errors: ' + errors.join(' | '));
  console.log('\nE2E PASSED');
} catch (err) {
  console.error('\nE2E FAILED:', err.message);
  if (errors.length) console.error('browser errors:', errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
}
