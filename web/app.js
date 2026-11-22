import { QUALITY, VoiceLink } from './rtc.js';
import { FlacSender, FlacPlayer } from './flac.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PTT_KEYS = [
  { value: 'v', label: 'V' },
  { value: 'b', label: 'B' },
  { value: 'f', label: 'F' },
  { value: '`', label: '`' },
  { value: 'space', label: '空格', wide: true },
];

const store = {
  get(key, def) {
    try {
      const raw = localStorage.getItem('qy.' + key);
      return raw == null ? def : JSON.parse(raw);
    } catch {
      return def;
    }
  },
  set(key, value) {
    try { localStorage.setItem('qy.' + key, JSON.stringify(value)); } catch { /* private mode */ }
  },
};

const app = {
  info: null,
  settings: {
    name: store.get('name', ''),
    quality: store.get('quality', 'standard'),
    inputId: store.get('inputId', ''),
    outputId: store.get('outputId', ''),
    pttKey: store.get('pttKey', 'v'),
    pttEnabled: store.get('pttEnabled', false),
    ec: store.get('ec', true),
    ns: store.get('ns', true),
    agc: store.get('agc', true),
    sounds: store.get('sounds', true),
    screenFps: store.get('screenFps', 30),
    screenHeight: store.get('screenHeight', 1080),
    screenBitrate: store.get('screenBitrate', 4000),
  },
  ws: null,
  token: '',
  fileToken: '',
  files: [],
  uploading: false,
  me: null,
  loggedIn: false,
  serverPassword: '',
  room: '',
  roomPassword: '',
  roomLocked: false,
  roomPending: false,
  roomDeferred: null,
  pendingJoin: null,
  pendingRoom: null,
  roomTarget: null,
  pendingRoomName: '',
  pendingRoomLocked: false,
  leaveDeferred: null,
  roomTimeout: null,
  inviteRoom: '',
  rooms: [],
  peers: new Map(),
  tiles: new Map(),
  link: null,
  localStream: null,
  audioCtx: null,
  meters: new Map(),
  listenOnly: false,
  joined: false,
  manualClose: false,
  reconnectTimer: null,
  attempts: 0,
  pingTimer: null,
  pingSentAt: 0,
  statsTimer: null,
  diagTimer: null,
  serverStats: null,
  rtt: null,
  muted: false,
  deafened: false,
  pttHeld: false,
  speakingSelf: false,
  lastLiveAt: 0,
  httpRtt: null,
  screen: {
    active: false,
    owner: false,
    pending: false,
    info: null,
    stream: null,
    video: null,
    timer: null,
    seq: 0,
    abort: null,
    objectURL: null,
    quality: 0.65,
    inFlight: false,
    bytes: 0,
    windowAt: 0,
  },
  flac: {
    sending: false,
    active: null,     // sender info currently being received
    player: null,     // decoder for someone else's FLAC
    sender: null,     // our FLAC capture/encoder
    sentBytes: 0,
    sentChunks: 0,
    startedAt: 0,
    timer: null,
  },
};

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

boot();

async function boot() {
  applySettingsToForm();
  renderQualityOptions($('#settings-quality'), true);
  bindEvents();
  await loadServerInfo();
  setInterval(() => {
    if (app.loggedIn) return;
    loadServerInfo().catch(() => {});
  }, 5000);
  setInterval(tickMeters, 100);
  window.__QY_READY = true;
}

function bindEvents() {
  $('#login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    login();
  });
  $('#logout-btn').addEventListener('click', logout);
  $('#create-room-btn').addEventListener('click', openCreateRoom);
  $('#cr-create').addEventListener('click', submitCreateRoom);
  $('#cr-cancel').addEventListener('click', closeCreateRoom);
  $('#cr-close').addEventListener('click', closeCreateRoom);
  $('#rp-enter').addEventListener('click', submitRoomPassword);
  $('#rp-cancel').addEventListener('click', () => { closeRoomPassword(); clearRoomConfirm(); });
  $('#rp-close').addEventListener('click', () => { closeRoomPassword(); clearRoomConfirm(); });
  $('#rc-enter').addEventListener('click', confirmSelectedRoom);
  $('#rc-cancel').addEventListener('click', clearRoomConfirm);
  $('#rp-password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitRoomPassword(); }
  });
  $('#cr-password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitCreateRoom(); }
  });
  $('#leave-btn').addEventListener('click', logout);

  $('#mic-btn').addEventListener('click', () => {
    if (app.listenOnly) return toast('当前是只听模式，刷新页面并允许麦克风即可发言', 'error');
    app.muted = !app.muted;
    guardFlacOnMute();
    applyMicGate();
    sendState();
    renderSelf();
  });
  $('#flac-btn').addEventListener('click', toggleFlac);
  $('#flac-action').addEventListener('click', () => {
    if (app.flac.sending) stopFlac(true);
    else stopListeningFlac();
  });
  $('#flac-volume').addEventListener('input', (e) => {
    if (app.flac.player) app.flac.player.setVolume(Number(e.target.value) / 100);
  });
  $('#deafen-btn').addEventListener('click', () => {
    app.deafened = !app.deafened;
    guardFlacOnMute();
    applyVolume();
    applyMicGate();
    sendState();
    renderSelf();
  });
  $('#ptt-btn').addEventListener('click', () => {
    app.settings.pttEnabled = !app.settings.pttEnabled;
    store.set('pttEnabled', app.settings.pttEnabled);
    renderPtt();
    sendState();
    toast(app.settings.pttEnabled
      ? `按住 ${pttKeyLabel()} 说话（页面需在前台）`
      : '已切回麦克风常开');
  });
  $('#copy-link').addEventListener('click', copyInvite);
  $('#open-settings').addEventListener('click', openSettings);
  $('#settings-btn').addEventListener('click', openSettings);
  $('#settings-close').addEventListener('click', closeSettings);
  $('#settings-cancel').addEventListener('click', closeSettings);
  $('#settings-apply').addEventListener('click', applySettings);
  $('#settings-modal').addEventListener('click', (e) => {
    if (e.target === $('#settings-modal')) closeSettings();
  });
  $('#refresh-devices').addEventListener('click', () => refreshDevices(true));

  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text) return;
    send({ t: 'chat', text });
    input.value = '';
  });
  $('#file-btn').addEventListener('click', () => {
    if (!app.joined) return;
    if (app.uploading) return toast('正在上传，请稍候', 'error');
    $('#file-input').click();
  });
  $('#screen-btn').addEventListener('click', () => {
    if (!app.joined) return;
    if (app.screen.active) {
      if ($('#screen-panel').classList.contains('hidden')) showScreenPanel();
      else hideScreenPanel();
      return;
    }
    openScreenOptions();
  });
  $('#screen-start').addEventListener('click', startScreenShare);
  $('#screen-cancel').addEventListener('click', closeScreenOptions);
  $('#screen-modal-cancel').addEventListener('click', closeScreenOptions);
  $('#screen-modal').addEventListener('click', (e) => {
    if (e.target === $('#screen-modal')) closeScreenOptions();
  });
  $('#screen-panel-close').addEventListener('click', hideScreenPanel);
  $('#screen-stop').addEventListener('click', () => stopScreenShare(true));
  $('#screen-full').addEventListener('click', () => {
    const box = document.querySelector('#screen-panel .screen-box');
    if (!box) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else box.requestFullscreen?.().catch(() => toast('当前浏览器不支持全屏', 'error'));
  });
  $('#file-input').addEventListener('change', (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    uploadFiles(files);
  });

  $('#open-chat').addEventListener('click', () => $('#chatpane').classList.toggle('open'));
  $('#close-chat').addEventListener('click', () => $('#chatpane').classList.remove('open'));
  $('#open-channels').addEventListener('click', () => $('#channels').classList.toggle('open'));
  $('#new-room').addEventListener('click', openCreateRoom);
  $('#banner-action').addEventListener('click', () => {
    const action = app.bannerAction;
    app.bannerAction = null;
    if (action) action();
  });

  document.addEventListener('pointerdown', () => {
    try { getAudioCtx().resume(); } catch { /* noop */ }
  }, { once: true });
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', () => {
    if (app.pttHeld) {
      app.pttHeld = false;
      applyMicGate();
      renderPtt();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && app.pttHeld) {
      app.pttHeld = false;
      applyMicGate();
      renderPtt();
    }
  });
  window.addEventListener('beforeunload', () => {
    try { send({ t: 'logout' }); } catch { /* noop */ }
  });

  const params = new URLSearchParams(location.search);
  app.inviteRoom = params.get('room') || '';
}

/* ------------------------------------------------------------------ */
/* server info, hall and room list                                    */
/* ------------------------------------------------------------------ */

async function loadServerInfo() {
  const t0 = performance.now();
  try {
    const res = await fetch('/api/info', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const info = await res.json();
    const sample = performance.now() - t0;
    app.httpRtt = app.httpRtt == null ? sample : app.httpRtt * 0.7 + sample * 0.3;
    if (!app.joined) {
      app.rtt = app.httpRtt;
      const lat = Math.round(app.httpRtt) + ' ms';
      if ($('#login-lat')) $('#login-lat').textContent = lat;
    }
    app.info = info;
    app.rooms = info.rooms || [];
    $('#server-name').textContent = info.name || 'KzBlackX Lossless Audio Tools';
    $('#sc-udp').textContent = 'UDP ' + info.udpPort;
    $('#sc-version').textContent = 'v' + info.version;
    $('#login-version').textContent = 'v' + info.version;
    $('#login-online').textContent = String(info.peers ?? 0);
    $('#login-rooms').textContent = String(app.rooms.length);
    $('#about-version').textContent = 'v' + info.version;
    $('#server-state').className = 'pill online';
    $('#server-state').innerHTML = '<i></i>在线';
    $('#password-field').classList.toggle('hidden', info.requiresPassword === false);
    if (info.stats) updateStats(info.stats);
    if (app.loggedIn) renderHall();
    refreshDevices(false).catch(() => {});
  } catch (err) {
    $('#server-state').className = 'pill offline';
    $('#server-state').innerHTML = '<i></i>无法连接';
    throw err;
  }
}

function updateStats(stats) {
  app.serverStats = stats;
  const rss = formatBytes(stats.rssBytes);
  const cpu = (stats.cpu || 0).toFixed(stats.cpu > 9 ? 0 : 1) + '%';
  if ($('#sc-rss')) $('#sc-rss').textContent = rss;
  if ($('#mini-rss')) $('#mini-rss').textContent = rss;
  if ($('#mini-cpu')) $('#mini-cpu').textContent = cpu;
  if ($('#login-online')) $('#login-online').textContent = String(stats.peers ?? 0);
  if ($('#login-rooms')) $('#login-rooms').textContent = String(stats.rooms ?? app.rooms.length);
  if ($('#sc-rooms')) $('#sc-rooms').textContent = `在线 ${stats.peers ?? 0} · 房间 ${stats.rooms ?? 0}`;
  if (app.joined && $('#stage-count')) {
    $('#stage-count').textContent = `${app.peers.size + 1} 人在线`;
  }
  if (app.rtt) {
    if ($('#login-lat')) $('#login-lat').textContent = Math.round(app.rtt) + ' ms';
    if ($('#sc-lat')) $('#sc-lat').textContent = Math.round(app.rtt) + ' ms';
  }
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function roomLockIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-lock');
  svg.append(use);
  return svg;
}

function renderHall() {
  const grid = $('#room-grid');
  if (!grid) return;
  grid.replaceChildren();
  const rooms = [...(app.rooms || [])];
  for (const room of rooms) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'room-card';
    const name = document.createElement('div');
    name.className = 'room-name';
    if (room.locked) name.append(roomLockIcon());
    const text = document.createElement('span');
    text.textContent = room.name;
    name.append(text);
    const meta = document.createElement('div');
    meta.className = 'room-meta';
    const dot = document.createElement('span');
    dot.className = 'live-dot';
    meta.append(dot, `${room.count} 人在线`);
    if (room.locked) meta.append(' · 已加密');
    const enter = document.createElement('div');
    enter.className = 'room-enter';
    enter.innerHTML = '<span>进入</span><svg viewBox="0 0 24 24"><use href="#i-chevron"/></svg>';
    card.append(name, meta, enter);
    card.addEventListener('click', () => requestRoom(room));
    grid.append(card);
  }
  if (rooms.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'hall-empty';
    empty.textContent = '还没有房间，点右上角创建一个。';
    grid.append(empty);
  }
  grid.append(buildCreateCard());
  const empty = $('#hall-empty');
  if (empty) empty.classList.add('hidden');
  if ($('#hall-name')) $('#hall-name').textContent = app.me?.name || '—';
  if (app.serverStats) updateStats(app.serverStats);
}

function buildCreateCard() {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'room-card create';
  card.innerHTML = '<svg viewBox="0 0 24 24"><use href="#i-plus"/></svg><b>创建房间</b><span>可以设置房间密码</span>';
  card.addEventListener('click', openCreateRoom);
  return card;
}

function renderChannels() {
  const list = $('#channel-list');
  if (!list) return;
  list.replaceChildren();
  for (const room of app.rooms || []) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'channel'
      + (room.name === app.room ? ' active' : '')
      + (room.name === app.pendingRoomName ? ' pending' : '');
    btn.innerHTML = '<svg viewBox="0 0 24 24"><use href="#i-users"/></svg>';
    if (room.locked) btn.append(roomLockIcon());
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = room.name;
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = room.count;
    btn.append(name, n);
    btn.addEventListener('click', () => {
      handleChannelClick(room);
    });
    list.append(btn);
  }
}

function renderQualityOptions(container, full) {
  if (!container) return;
  container.replaceChildren();
  for (const q of Object.values(QUALITY)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'q-option' + (app.settings.quality === q.id ? ' active' : '');
    btn.dataset.quality = q.id;
    const b = document.createElement('b');
    b.textContent = q.name;
    const s = document.createElement('span');
    s.textContent = q.desc;
    btn.append(b, s);
    btn.addEventListener('click', () => {
      app.settings.quality = q.id;
      store.set('quality', q.id);
      app.settings.ec = q.ec;
      app.settings.ns = q.ns;
      app.settings.agc = q.agc;
      store.set('ec', q.ec); store.set('ns', q.ns); store.set('agc', q.agc);
      renderQualityOptions($('#settings-quality'), true);
      syncHardwareToggles();
      updateQualityBadge();
      if (full) toast(`音质：${q.name} · ${q.kbps}k`, 'ok');
    });
    container.append(btn);
  }
}

function updateQualityBadge() {
  const q = QUALITY[app.settings.quality] || QUALITY.standard;
  $('#quality-badge').textContent = `${q.name} · ${q.kbps}k`;
  if (app.joined) $('#quality-badge').title = `Opus 上限 ${q.kbps}kbps`;
}

function applySettingsToForm() {
  $('#name').value = app.settings.name || '';
  updateQualityBadge();
  $('#ptt-btn kbd').textContent = pttKeyLabel();
  renderPtt();
  syncHardwareToggles();
}

function syncHardwareToggles() {
  $('#ec-toggle').checked = !!app.settings.ec;
  $('#ns-toggle').checked = !!app.settings.ns;
  $('#agc-toggle').checked = !!app.settings.agc;
  $('#sounds-toggle').checked = !!app.settings.sounds;
  renderPttKeys();
}

function renderPttKeys() {
  const container = $('#ptt-key');
  if (!container) return;
  container.dataset.value = app.settings.pttKey;
  container.replaceChildren();
  for (const key of PTT_KEYS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'key-chip' + (key.value === app.settings.pttKey ? ' active' : '') + (key.wide ? ' wide' : '');
    btn.textContent = key.label;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', key.value === app.settings.pttKey ? 'true' : 'false');
    btn.addEventListener('click', () => {
      app.settings.pttKey = key.value;
      store.set('pttKey', key.value);
      renderPttKeys();
      renderPtt();
    });
    container.append(btn);
  }
}

/* ------------------------------------------------------------------ */
/* login / hall / room lifecycle                                       */
/* ------------------------------------------------------------------ */

async function login() {
  if (app.loggedIn) return;
  const name = ($('#name').value || '').trim();
  const password = $('#password').value;
  if (!name) {
    showLoginError('请先输入你的名字');
    $('#name').focus();
    return;
  }
  if (app.info?.requiresPassword && !password) {
    $('#password-field').classList.remove('hidden');
    showLoginError('这个服务器需要密码');
    $('#password').focus();
    return;
  }
  try { getAudioCtx(); } catch { /* noop */ }
  app.settings.name = name;
  store.set('name', name);
  app.serverPassword = password;
  setLoginBusy(true, '正在连接…');
  try {
    await connect();
  } catch (err) {
    setLoginBusy(false);
    showLoginError(humanError(err));
  }
}

function setLoginBusy(busy, note) {
  const btn = $('#login-btn');
  if (btn) btn.disabled = busy;
  if (note) showLoginNote(note, false);
}

function showLoginNote(text, error = false) {
  const note = $('#login-note');
  if (!note) return;
  note.textContent = text;
  note.classList.toggle('error', !!error);
}

function showLoginError(text) {
  showLoginNote(text, true);
}

function connect() {
  return new Promise((resolve, reject) => {
    closeSocket();
    closeLink();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws;
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws`);
    } catch (err) {
      reject(err);
      return;
    }
    app.ws = ws;
    ws.binaryType = 'arraybuffer';
    app.manualClose = false;
    app.loginDeferred = { resolve, reject };
    const timeout = setTimeout(() => {
      if (app.loginDeferred) {
        app.loginDeferred = null;
        try { ws.close(); } catch { /* noop */ }
        reject(new Error('连接超时，检查地址和端口'));
      }
    }, 12000);
    ws._loginTimeout = timeout;

    ws.onopen = () => {
      ws.send(JSON.stringify({
        t: 'login',
        name: app.settings.name,
        password: app.serverPassword,
      }));
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') {
        onFlacBinary(ev.data);
        return;
      }
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      onServerMessage(msg);
    };
    ws.onclose = () => onSocketClose(ws);
    ws.onerror = () => { /* onclose handles it */ };
  });
}

async function handleWelcome(msg) {
  app.loggedIn = true;
  app.token = msg.token || '';
  app.me = msg.self;
  app.rooms = msg.rooms || [];
  app.info = { ...(app.info || {}), ...(msg.settings || {}) };
  if (msg.settings?.requiresPassword != null) app.info.requiresPassword = msg.settings.requiresPassword;
  clearTimeout(app.ws?._loginTimeout);
  const deferred = app.loginDeferred;
  app.loginDeferred = null;
  deferred?.resolve?.();
  const invited = app.inviteRoom ? app.rooms.find((r) => r.name === app.inviteRoom) : null;
  app.inviteRoom = '';
  if (app.reconnecting) {
    $('#login').classList.add('hidden');
    $('#hall').classList.add('hidden');
    return;
  }
  setLoginBusy(false);
  showRoomShell();
  if (invited) {
    app.pendingRoomName = invited.name;
    app.pendingRoomLocked = !!invited.locked;
    renderChannels();
    showRoomConfirm(invited);
    toast(`邀请房间：${invited.name}，再点一次左侧房间进入`, 'ok');
  }
}

function showRoomShell() {
  if (!app.loggedIn) return;
  stopTimers();
  closeLink();
  clearPeers();
  resetFlac();
  stopLocalStream();
  app.joined = false;
  app.room = '';
  app.roomPassword = '';
  app.roomLocked = false;
  app.fileToken = '';
  app.files = [];
  resetScreen();
  app.pendingRoomName = '';
  app.pendingRoomLocked = false;
  bannerHide();
  $('#room-confirm').classList.add('hidden');
  $('#login').classList.add('hidden');
  $('#hall').classList.add('hidden');
  $('#roomview').classList.remove('hidden');
  $('#current-room').textContent = '未加入房间';
  $('#conn-text').textContent = '已登录';
  $('#conn-dot').className = 'conn-dot online';
  $('#stage-title').textContent = '选择房间';
  $('#stage-count').textContent = '点击左侧房间进入';
  $('#stage-live').style.visibility = 'hidden';
  $('#room-empty').classList.remove('hidden');
  $('#peer-grid').hidden = true;
  $('#peer-grid').replaceChildren();
  app.tiles.clear();
  $('#chat-log').replaceChildren();
  renderChatEmpty('进入房间后可以聊天');
  renderFiles();
  setInRoomControls(false);
  $('#self-name').textContent = app.me?.name || '—';
  $('#self-avatar').textContent = initial(app.me?.name || '我');
  $('#self-avatar').style.setProperty('--hue', hueFor(app.me?.name || '我'));
  $('#self-state').textContent = '未进入房间';
  $('#rtt').textContent = '—';
  const leaveText = $('#leave-btn span');
  if (leaveText) leaveText.textContent = '退出登录';
  renderChannels();
  updateFlacButton();
}

function setInRoomControls(active) {
  for (const id of ['mic-btn', 'deafen-btn', 'flac-btn', 'ptt-btn', 'screen-btn']) {
    const el = document.getElementById(id);
    if (el) el.disabled = !active;
  }
  const input = $('#chat-input');
  if (input) {
    input.disabled = !active;
    input.placeholder = active ? '说点什么…' : '进入房间后可聊天';
  }
  const send = $('#chat-form button');
  if (send) send.disabled = !active;
  const copy = $('#copy-link');
  if (copy) copy.disabled = !active;
  const fileBtn = $('#file-btn');
  if (fileBtn) fileBtn.disabled = !active;
  updateScreenButton();
}

function showRoomConfirm(room) {
  $('#rc-title').textContent = `进入「${room.name}」？`;
  $('#rc-sub').textContent = room.locked
    ? '再次点击左侧房间，然后输入房间密码'
    : '再次点击左侧房间，或点右侧“进入”。';
  $('#room-confirm').classList.remove('hidden');
}

function clearRoomConfirm() {
  app.pendingRoomName = '';
  app.pendingRoomLocked = false;
  $('#room-confirm').classList.add('hidden');
  renderChannels();
}

function handleChannelClick(room) {
  if (app.roomPending) return;
  if (room.name === app.room) {
    if (app.pendingRoomName) clearRoomConfirm();
    return;
  }
  if (app.pendingRoomName === room.name) {
    confirmSelectedRoom();
    return;
  }
  app.pendingRoomName = room.name;
  app.pendingRoomLocked = !!room.locked;
  renderChannels();
  showRoomConfirm(room);
}

async function confirmSelectedRoom() {
  const room = app.rooms.find((r) => r.name === app.pendingRoomName);
  if (!room) {
    clearRoomConfirm();
    return;
  }
  if (room.locked) {
    openRoomPassword(room, app.joined);
    return;
  }
  try {
    await enterConfirmed(room);
  } catch (err) {
    if (err.code !== 'room_password') toast(humanError(err), 'error');
  }
}

async function enterConfirmed(room, password = '') {
  if (app.roomPending) return;
  const wasJoined = app.joined;
  clearRoomConfirm();
  $('#channels').classList.remove('open');
  try {
    if (wasJoined) {
      await leaveRoom({ quiet: true });
      showRoomShell();
    }
    await prepareRoom(room.name, password, false);
  } catch (err) {
    if (!app.joined) showRoomShell();
    throw err;
  }
}

function showHall() {
  if (!app.loggedIn) return;
  $('#login').classList.add('hidden');
  $('#roomview').classList.add('hidden');
  $('#hall').classList.remove('hidden');
  $('#hall-name').textContent = app.me?.name || '—';
  renderHall();
}

function showLogin() {
  $('#hall').classList.add('hidden');
  $('#roomview').classList.add('hidden');
  $('#login').classList.remove('hidden');
  setLoginBusy(false);
  showLoginNote('登录后在左侧选择房间：第一次确认，第二次进入。');
  $('#name').value = app.settings.name || '';
  $('#password').value = '';
  $('#password-field').classList.toggle('hidden', app.info?.requiresPassword === false);
  setTimeout(() => $('#name')?.focus(), 50);
}

function requestRoom(room) {
  if (!app.loggedIn || app.roomPending) return;
  if (room.locked) {
    openRoomPassword(room, false);
    return;
  }
  enterOrSwitch(room.name, '', false).catch((err) => {
    if (err.code !== 'room_password') toast(humanError(err), 'error');
  });
}

function requestRoomSwitch(room) {
  if (!app.loggedIn || app.roomPending) return;
  if (room.locked) {
    openRoomPassword(room, true);
    return;
  }
  enterOrSwitch(room.name, '', true).catch((err) => {
    if (err.code !== 'room_password') toast(humanError(err), 'error');
  });
}

async function enterOrSwitch(name, password, switchMode) {
  if (app.roomPending) return;
  if (switchMode && app.joined) {
    await leaveRoom({ quiet: true });
  }
  await prepareRoom(name, password, false);
  closeRoomPassword();
  closeCreateRoom();
}

function openRoomPassword(room, switchMode) {
  app.roomTarget = { room, switchMode };
  $('#room-confirm').classList.add('hidden');
  $('#rp-roomname').textContent = room.name;
  $('#rp-password').value = '';
  $('#rp-error').classList.add('hidden');
  $('#room-password-modal').classList.remove('hidden');
  setTimeout(() => $('#rp-password').focus(), 50);
}

function closeRoomPassword() {
  $('#room-password-modal').classList.add('hidden');
}

async function submitRoomPassword() {
  const target = app.roomTarget;
  if (!target) return;
  const password = $('#rp-password').value;
  try {
    await enterConfirmed(target.room, password);
    closeRoomPassword();
  } catch (err) {
    if (err.code === 'room_password') {
      $('#rp-error').textContent = '房间密码不正确';
      $('#rp-error').classList.remove('hidden');
    } else {
      closeRoomPassword();
      toast(humanError(err), 'error');
    }
  }
}

function openCreateRoom() {
  if (!app.loggedIn) return;
  $('#cr-name').value = '';
  $('#cr-password').value = '';
  $('#cr-error').classList.add('hidden');
  $('#create-room-modal').classList.remove('hidden');
  setTimeout(() => $('#cr-name').focus(), 50);
}

function closeCreateRoom() {
  $('#create-room-modal').classList.add('hidden');
}

async function submitCreateRoom() {
  const name = ($('#cr-name').value || '').trim();
  const password = $('#cr-password').value;
  if (!name) {
    $('#cr-error').textContent = '房间名不能为空';
    $('#cr-error').classList.remove('hidden');
    return;
  }
  try {
    clearRoomConfirm();
    if (app.joined) {
      await leaveRoom({ quiet: true });
      showRoomShell();
    }
    await prepareRoom(name, password, true);
    closeCreateRoom();
  } catch (err) {
    if (!app.joined) showRoomShell();
    $('#cr-error').textContent = humanError(err);
    $('#cr-error').classList.remove('hidden');
  }
}

async function prepareRoom(name, password, create, { auto = false } = {}) {
  if (app.roomPending) throw new Error('正在进入房间，请稍候');
  app.roomPending = true;
  app.pendingJoin = { name, password, create };

  if (!app.listenOnly && !app.localStream) {
    try {
      await ensureMic();
    } catch (err) {
      app.listenOnly = true;
      toast('无法使用麦克风，将以只听模式进入：' + humanError(err), 'error');
    }
  }

  const promise = new Promise((resolve, reject) => {
    app.roomDeferred = { resolve, reject };
  });
  app.roomTimeout = setTimeout(() => {
    if (app.roomDeferred) {
      const d = app.roomDeferred;
      app.roomDeferred = null;
      app.roomPending = false;
      d.reject(new Error('进入房间超时'));
    }
  }, 12000);

  send({
    t: create ? 'create-room' : 'join-room',
    room: name,
    password,
  });

  try {
    await promise;
  } catch (err) {
    app.pendingJoin = null;
    if (!app.joined) stopLocalStream();
    app.roomPending = false;
    throw err;
  } finally {
    clearTimeout(app.roomTimeout);
    app.roomPending = false;
  }
}

async function handleRoomJoined(msg) {
  setLoginBusy(false);
  const pending = app.pendingJoin || {};
  app.pendingJoin = null;
  app.roomPending = false;
  app.joined = true;
  app.room = msg.room.name;
  app.roomPassword = pending.password || '';
  app.roomLocked = !!msg.room.locked;
  app.fileToken = msg.fileToken || '';
  app.files = msg.files || [];
  if (app.localStream) app.listenOnly = false;

  closeRoomPassword();
  closeCreateRoom();
  $('#login').classList.add('hidden');
  $('#hall').classList.add('hidden');
  $('#roomview').classList.remove('hidden');
  app.pendingRoomName = '';
  app.pendingRoomLocked = false;
  playCue('enter');
  $('#room-confirm').classList.add('hidden');
  $('#room-empty').classList.add('hidden');
  $('#channels').classList.remove('open');
  $('#peer-grid').hidden = false;
  $('#stage-live').style.visibility = '';
  setInRoomControls(true);
  const leaveText = $('#leave-btn span');
  if (leaveText) leaveText.textContent = '离开房间';
  $('#current-room').textContent = app.room;
  $('#stage-title').textContent = app.room;
  $('#stage-count').textContent = `${(msg.peers?.length || 0) + 1} 人在线`;
  $('#self-name').textContent = app.me.name;
  $('#self-avatar').textContent = initial(app.me.name);
  $('#self-avatar').style.setProperty('--hue', hueFor(app.me.name));
  $('#chat-log').replaceChildren();
  clearPeers();
  app.tiles.clear();
  for (const peer of msg.peers || []) {
    if (peer.id !== app.me.id) upsertPeer(peer);
  }
  if (msg.history && msg.history.length) {
    for (const m of msg.history) addChat(m);
  } else {
    renderChatEmpty();
  }
  renderChannels();
  renderParticipants();
  renderFiles();
  if (msg.screen) startScreenViewer(msg.screen);
  resetFlac();
  bannerHide();
  updateQualityBadge();
  setConnState('connecting');

  const deferred = app.roomDeferred;
  app.roomDeferred = null;
  clearTimeout(app.roomTimeout);
  deferred?.resolve?.(msg);

  try {
    await setupRoomMedia();
  } catch (err) {
    toast('音频初始化失败：' + humanError(err), 'error');
    banner('音频不可用', humanError(err), '');
  }
}

async function setupRoomMedia() {
  if (!app.localStream && !app.listenOnly) {
    try {
      await ensureMic();
    } catch (err) {
      app.listenOnly = true;
      banner('麦克风不可用', '已按只听模式进入：' + humanError(err), '');
    }
  }
  app.link = new VoiceLink({
    onSignal: (m) => send(m),
    onTrack: (peerId, stream) => attachAudio(peerId, stream),
    onScreenTrack: (peerId, stream) => onScreenTrack(peerId, stream),
    onState: (s) => setConnState(s),
    onLog: (line) => console.debug('[rtc]', line),
  });
  const q = QUALITY[app.settings.quality] || QUALITY.standard;
  await app.link.start(app.listenOnly ? null : app.localStream, q.kbps);
  send({ t: 'quality', bitrate: q.kbps });
  if (app.localStream) attachMeter('self', app.localStream);
  applyMicGate();
  sendState();
  renderParticipants();
  app.pingSentAt = performance.now();
  send({ t: 'ping', ts: Date.now() });
  startTimers();
  updateFlacButton();
}

function teardownRoom() {
  stopTimers();
  closeLink();
  clearPeers();
  resetFlac();
  stopLocalStream();
  hideFlacBar();
  bannerHide();
  app.joined = false;
  app.room = '';
  app.roomPassword = '';
  app.roomLocked = false;
  app.listenOnly = false;
  if ($('#roomview')) $('#roomview').classList.add('hidden');
  if ($('#chat-log')) $('#chat-log').replaceChildren();
}

async function leaveRoom({ quiet = false } = {}) {
  if (!app.joined) return;
  const left = new Promise((resolve) => { app.leaveDeferred = resolve; });
  send({ t: 'leave-room' });
  teardownRoom();
  if (!quiet) showRoomShell();
  await Promise.race([left, sleep(900)]);
  app.leaveDeferred = null;
}

function logout() {
  playCue('leave');
  resetScreen();
  app.manualClose = true;
  clearTimeout(app.reconnectTimer);
  app.reconnectTimer = null;
  app.reconnecting = false;
  try { send({ t: 'logout' }); } catch { /* noop */ }
  closeSocket();
  teardownRoom();
  app.loggedIn = false;
  app.me = null;
  app.rooms = [];
  app.serverPassword = '';
  app.pendingRoom = null;
  showLogin();
}

function onSocketClose(ws) {
  if (app.ws !== ws) return;
  app.ws = null;
  clearTimeout(ws._loginTimeout);
  if (app.loginDeferred) {
    const d = app.loginDeferred;
    app.loginDeferred = null;
    d.reject(new Error('连接已断开'));
    setLoginBusy(false);
    if (!app.loggedIn) showLoginError('无法连接服务器');
    return;
  }
  if (app.manualClose || !app.loggedIn) return;

  app.pendingRoom = app.joined
    ? { name: app.room, password: app.roomPassword }
    : null;
  teardownRoom();
  app.loggedIn = true;
  showRoomShell();
  banner('连接断开', '正在重新连接…', '立即重连', reconnectNow);
  scheduleReconnect();
}

function scheduleReconnect() {
  if (app.reconnectTimer || app.manualClose) return;
  const delay = Math.min(10000, 700 * 2 ** Math.min(app.attempts, 4));
  app.attempts++;
  app.reconnectTimer = setTimeout(async () => {
    app.reconnectTimer = null;
    app.reconnecting = true;
    try {
      await connect();
      bannerHide();
      toast('已重新连接', 'ok');
      const pending = app.pendingRoom;
      app.pendingRoom = null;
      if (pending) {
        try {
          await prepareRoom(pending.name, pending.password, false, { auto: true });
        } catch (err) {
          toast('重新进入房间失败：' + humanError(err), 'error');
          showRoomShell();
        }
      }
      app.reconnecting = false;
    } catch (err) {
      app.reconnecting = false;
      if (err.code === 'bad_password' || err.code === 'rate_limited') {
        toast('无法重新登录：' + humanError(err), 'error');
        logout();
        return;
      }
      scheduleReconnect();
    }
  }, delay);
}

async function reconnectNow() {
  clearTimeout(app.reconnectTimer);
  app.reconnectTimer = null;
  app.reconnecting = true;
  try {
    await connect();
    bannerHide();
    toast('已重新连接', 'ok');
    const pending = app.pendingRoom;
    app.pendingRoom = null;
    if (pending) {
      try {
        await prepareRoom(pending.name, pending.password, false, { auto: true });
      } catch (err) {
        toast('重新进入房间失败：' + humanError(err), 'error');
      }
    }
    app.reconnecting = false;
  } catch (err) {
    app.reconnecting = false;
    if (err.code === 'bad_password') {
      logout();
      return;
    }
    toast('仍然连不上：' + humanError(err), 'error');
    scheduleReconnect();
  }
}

function handleServerError(msg) {
  if (msg.code === 'flac_busy') {
    stopFlac(false);
    toast('房间里已经有人在发送无损音频', 'error');
    return;
  }
  if (msg.code === 'screen_busy') {
    stopScreenShare(false);
    toast('房间里已经有人在共享桌面', 'error');
    return;
  }
  if (app.roomDeferred) {
    const d = app.roomDeferred;
    app.roomDeferred = null;
    clearTimeout(app.roomTimeout);
    app.roomPending = false;
    const err = new Error(msg.message || msg.code || '无法进入房间');
    err.code = msg.code;
    d.reject(err);
    return;
  }
  if (!app.loggedIn && app.loginDeferred) {
    const d = app.loginDeferred;
    app.loginDeferred = null;
    clearTimeout(app.ws?._loginTimeout);
    const err = new Error(msg.message || msg.code || '登录失败');
    err.code = msg.code;
    d.reject(err);
    return;
  }
  toast(msg.message || '服务器返回错误', 'error');
}

/* ------------------------------------------------------------------ */
/* websocket messages                                                  */
/* ------------------------------------------------------------------ */

function onServerMessage(msg) {
  switch (msg.t) {
    case 'welcome':
      handleWelcome(msg).catch((err) => {
        toast('登录后初始化失败：' + humanError(err), 'error');
        showRoomShell();
      });
      break;
    case 'room-joined':
      handleRoomJoined(msg).catch((err) => {
        toast('进入房间失败：' + humanError(err), 'error');
        app.roomPending = false;
        const d = app.roomDeferred;
        app.roomDeferred = null;
        d?.reject?.(err);
      });
      break;
    case 'room-left':
      if (app.leaveDeferred) {
        const done = app.leaveDeferred;
        app.leaveDeferred = null;
        done();
      }
      if (app.joined) {
        teardownRoom();
        showRoomShell();
      }
      break;
    case 'peer-joined':
      if (!app.joined || !msg.peer || msg.peer.id === app.me?.id) return;
      upsertPeer(msg.peer);
      addSystem(`${msg.peer.name} 加入了房间`);
      playCue('enter');
      renderParticipants();
      break;
    case 'peer-left': {
      const peer = app.peers.get(msg.id);
      if (peer) {
        addSystem(`${peer.name} 离开了房间`);
        playCue('leave');
        removePeer(msg.id);
      }
      break;
    }
    case 'peer-state': {
      const peer = app.peers.get(msg.id);
      if (peer) {
        peer.muted = !!msg.muted;
        renderParticipants();
      }
      break;
    }
    case 'rooms':
      app.rooms = msg.rooms || [];
      if (app.loggedIn) renderHall();
      if (app.joined) renderChannels();
      break;
    case 'chat':
      addChat(msg.chat);
      break;
    case 'file-shared':
      if (msg.file) {
        if (!app.files.some((f) => f.id === msg.file.id)) {
          app.files.push(msg.file);
          app.files.sort((a, b) => a.ts - b.ts);
          renderFiles();
        }
        if (msg.file.fromId !== app.me?.id) toast(`${msg.file.from} 分享了文件：${msg.file.name}`, 'ok');
      }
      break;
    case 'file-removed':
      app.files = app.files.filter((f) => f.id !== msg.id);
      renderFiles();
      break;
    case 'screen-started':
      onScreenStarted(msg.screen);
      break;
    case 'screen-stopped':
      onScreenStopped(msg.id, msg.reason);
      break;
    case 'offer':
      if (app.link) app.link.handleOffer(msg.sdp);
      break;
    case 'answer':
      if (app.link) app.link.handleAnswer(msg.sdp);
      break;
    case 'candidate':
      if (app.link) app.link.handleCandidate(msg.candidate);
      break;
    case 'pong': {
      const rtt = performance.now() - (app.pingSentAt || performance.now());
      app.rtt = rtt;
      if ($('#rtt')) $('#rtt').textContent = Math.round(rtt) + ' ms';
      if ($('#login-lat')) $('#login-lat').textContent = Math.round(rtt) + ' ms';
      if ($('#sc-lat')) $('#sc-lat').textContent = Math.round(rtt) + ' ms';
      break;
    }
    case 'stats':
      updateStats(msg);
      break;
    case 'flac-started':
      onFlacStarted(msg);
      break;
    case 'flac-stopped':
      onFlacStopped(msg);
      break;
    case 'error':
      handleServerError(msg);
      break;
    default:
      break;
  }
}

function startTimers() {
  stopTimers();
  app.pingTimer = setInterval(() => {
    if (app.ws?.readyState !== WebSocket.OPEN) return;
    app.pingSentAt = performance.now();
    send({ t: 'ping', ts: Date.now() });
  }, 5000);
  app.statsTimer = setInterval(async () => {
    if (!app.link) return;
    const s = await app.link.stats();
    if (!s) return;
    if (s.rtt != null && !app.rtt) {
      app.rtt = s.rtt;
      if ($('#rtt')) $('#rtt').textContent = Math.round(s.rtt) + ' ms';
    }
    if ($('#settings-modal')?.classList.contains('hidden')) return;
    renderDiag(s);
  }, 2000);
}

function stopTimers() {
  clearInterval(app.pingTimer);
  clearInterval(app.statsTimer);
  app.pingTimer = null;
  app.statsTimer = null;
}

function closeSocket() {
  if (!app.ws) return;
  const ws = app.ws;
  app.ws = null;
  ws.onopen = null;
  ws.onmessage = null;
  ws.onclose = null;
  ws.onerror = null;
  try { ws.close(); } catch { /* noop */ }
}

function closeLink() {
  if (app.link) {
    app.link.close();
    app.link = null;
  }
  for (const id of [...app.meters.keys()]) detachMeter(id);
}

/* ------------------------------------------------------------------ */
/* microphone, PTT, mute                                               */
/* ------------------------------------------------------------------ */

async function ensureMic() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('当前环境不允许麦克风（需要 HTTPS 或 localhost）');
  }
  const q = QUALITY[app.settings.quality] || QUALITY.standard;
  const audio = {
    echoCancellation: !!app.settings.ec,
    noiseSuppression: !!app.settings.ns,
    autoGainControl: !!app.settings.agc,
    channelCount: q.stereo ? { ideal: 2 } : { ideal: 1 },
    sampleRate: { ideal: 48000 },
  };
  if (app.settings.inputId) audio.deviceId = { exact: app.settings.inputId };
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    replaceLocalStream(stream);
    await refreshDevices(false);
    return stream;
  } catch (err) {
    // Fall back to default device if the saved device disappeared.
    if (app.settings.inputId && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
      app.settings.inputId = '';
      store.set('inputId', '');
      return ensureMic();
    }
    throw err;
  }
}

function replaceLocalStream(stream) {
  if (app.localStream) {
    for (const track of app.localStream.getTracks()) track.stop();
  }
  app.localStream = stream;
  attachMeter('self', stream);
  applyMicGate();
}

function stopLocalStream() {
  if (app.localStream) {
    for (const track of app.localStream.getTracks()) track.stop();
    app.localStream = null;
  }
  detachMeter('self');
}

function micEnabled() {
  if (app.listenOnly || !app.localStream) return false;
  if (app.deafened || app.muted) return false;
  if (app.settings.pttEnabled) return app.pttHeld;
  return true;
}

function applyMicGate() {
  const enabled = micEnabled();
  if (app.link) app.link.setMicEnabled(enabled);
  renderSelf();
}

function guardFlacOnMute() {
  if (app.flac.sending && (app.muted || app.deafened)) {
    stopFlac(true);
    toast('已停止 FLAC 无损发送（麦克风被静音/闭音）', 'ok');
  }
}

function applyVolume() {
  for (const peer of app.peers.values()) {
    if (peer.audio) peer.audio.muted = app.deafened;
    if (peer.audio) peer.audio.volume = app.deafened ? 0 : clamp(peer.volume ?? 1, 0, 1);
  }
  if (app.flac.player) {
    const volume = app.deafened ? 0 : Number($('#flac-volume').value || 100) / 100;
    app.flac.player.setVolume(volume);
  }
  if (app.localStream) {
    for (const track of app.localStream.getAudioTracks()) {
      track.enabled = micEnabled();
    }
  }
  $('#deafen-btn').classList.toggle('active', app.deafened);
}

function sendState() {
  send({ t: 'state', muted: app.deafened || app.muted || app.listenOnly || !app.localStream });
}

function onKeyDown(e) {
  if (!app.joined) return;
  if (isTyping(e.target)) return;
  if (e.repeat) return;
  const key = e.key === ' ' ? 'space' : e.key.toLowerCase();
  if (key === app.settings.pttKey && app.settings.pttEnabled && !app.listenOnly) {
    e.preventDefault();
    if (!app.pttHeld) {
      app.pttHeld = true;
      applyMicGate();
      renderPtt();
    }
  }
  if (key === 'm' && !e.metaKey && !e.ctrlKey && !e.altKey) {
    app.muted = !app.muted;
    applyMicGate();
    sendState();
  }
}

function onKeyUp(e) {
  if (!app.settings.pttEnabled) return;
  const key = e.key === ' ' ? 'space' : e.key.toLowerCase();
  if (key === app.settings.pttKey && app.pttHeld) {
    app.pttHeld = false;
    applyMicGate();
    renderPtt();
  }
}

function isTyping(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function pttKeyLabel() {
  const k = app.settings.pttKey;
  return k === 'space' ? '空格' : k === ' ' ? '空格' : k.toUpperCase();
}

/* ------------------------------------------------------------------ */
/* audio plumbing                                                      */
/* ------------------------------------------------------------------ */

function getAudioCtx() {
  if (!app.audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    app.audioCtx = new Ctx({ latencyHint: 'interactive' });
  }
  if (app.audioCtx.state === 'suspended') app.audioCtx.resume().catch(() => {});
  return app.audioCtx;
}

// Short synthesized room cues: no audio files to download. The cue respects
// the "提示音" setting and is skipped when the user is deafened.
function playCue(kind) {
  if (!app.settings.sounds || app.deafened) return;
  try {
    const ctx = getAudioCtx();
    const now = ctx.currentTime + 0.01;
    const notes = kind === 'leave' ? [659.25, 440] : [523.25, 659.25];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + i * 0.11);
      const t = now + i * 0.11;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.075, t + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.18);
    });
  } catch { /* audio context may be unavailable */ }
}

function attachMeter(id, stream) {
  detachMeter(id);
  if (!stream) return;
  try {
    const ctx = getAudioCtx();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.65;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    app.meters.set(id, { source, analyser, data, speaking: false, level: 0 });
  } catch (err) {
    console.debug('meter', err);
  }
}

function detachMeter(id) {
  const m = app.meters.get(id);
  if (!m) return;
  try { m.source.disconnect(); } catch { /* noop */ }
  try { m.analyser.disconnect(); } catch { /* noop */ }
  app.meters.delete(id);
}

function tickMeters() {
  const now = Date.now();
  for (const [id, m] of app.meters) {
    m.analyser.getByteTimeDomainData(m.data);
    let sum = 0;
    for (let i = 0; i < m.data.length; i++) {
      const v = (m.data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / m.data.length);
    m.level = rms;
    if (m.floor == null) m.floor = rms;
    // Adaptive gate: learn the room's noise floor while quiet, then open on
    // anything clearly above it. Avoids both "always speaking" and "never
    // speaking" on quiet or noisy microphones.
    const threshold = Math.max(0.0045, m.floor * 2.3 + 0.001);
    if (rms > threshold) m.lastVoice = now;
    const speaking = now - (m.lastVoice || 0) < 350;
    if (!speaking) m.floor = m.floor * 0.95 + rms * 0.05;
    let visible = speaking;
    if (id === 'self' && !micEnabled()) visible = false;
    if (app.deafened) visible = false;
    if (visible !== m.speaking) {
      m.speaking = visible;
      const tile = app.tiles.get(id);
      if (tile) tile.classList.toggle('speaking', visible);
      if (visible) app.lastLiveAt = now;
    }
  }
  $('#stage-live')?.classList.toggle('quiet', Date.now() - app.lastLiveAt > 4000);
}

function attachAudio(peerId, stream) {
  // Chrome fires an extra "track" event without the real msid while the server
  // renegotiates (the announced stream id is a random UUID). Ignore anything
  // that does not belong to a participant we already know about; the same
  // receiver fires again with the publisher's real id.
  if (!app.peers.has(peerId)) {
    console.debug('[rtc] ignoring track for unknown stream', peerId);
    return;
  }
  const peer = app.peers.get(peerId);
  const incoming = stream.getAudioTracks()[0];
  if (peer.audio && peer.stream && peer.stream.getAudioTracks()[0] === incoming) {
    return;
  }
  if (peer.audio) {
    try { peer.audio.srcObject = null; } catch { /* noop */ }
    peer.audio.remove();
  }
  const audio = new Audio();
  audio.autoplay = true;
  audio.playsInline = true;
  audio.srcObject = stream;
  audio.volume = app.deafened ? 0 : clamp(peer.volume ?? 1, 0, 1);
  audio.muted = app.deafened;
  audio.style.display = 'none';
  document.body.append(audio);
  audio.play().catch(() => {
    banner('需要一次点击', '浏览器阻止了自动播放，点此恢复声音', '恢复声音', () => { unlockAudio(); bannerHide(); });
  });
  if (app.settings.outputId && audio.setSinkId) {
    audio.setSinkId(app.settings.outputId).catch(() => {});
  }
  peer.audio = audio;
  peer.stream = stream;
  attachMeter(peerId, stream);
  renderParticipants();
}

/* ------------------------------------------------------------------ */
/* peers + rendering                                                   */
/* ------------------------------------------------------------------ */

function upsertPeer(info) {
  let peer = app.peers.get(info.id);
  if (!peer) {
    peer = { id: info.id, name: info.name || shortId(info.id), muted: !!info.muted, joinedAt: info.joinedAt || Date.now(), volume: 1, audio: null };
    app.peers.set(info.id, peer);
  } else {
    peer.name = info.name || peer.name;
    peer.muted = !!info.muted;
  }
  return peer;
}

function removePeer(id) {
  const peer = app.peers.get(id);
  if (!peer) return;
  detachMeter(id);
  if (peer.audio) {
    try { peer.audio.srcObject = null; } catch { /* noop */ }
    peer.audio.remove();
  }
  app.peers.delete(id);
  const tile = app.tiles.get(id);
  if (tile) tile.remove();
  app.tiles.delete(id);
  renderParticipants();
}

function clearPeers() {
  for (const id of [...app.peers.keys()]) removePeer(id);
  for (const id of [...app.meters.keys()]) detachMeter(id);
  app.tiles.clear();
  app.peers.clear();
  renderParticipants();
}

function renderParticipants() {
  const grid = $('#peer-grid');
  if (!grid) return;
  grid.replaceChildren();
  app.tiles.clear();

  const selfTile = buildTile({
    id: 'self', name: app.me?.name || '你', isSelf: true,
    muted: !micEnabled(), speaking: app.meters.get('self')?.speaking || false,
  });
  app.tiles.set('self', selfTile);
  app.tiles.set(app.me?.id || 'self', selfTile);
  grid.append(selfTile);

  const peers = [...app.peers.values()].sort((a, b) => a.joinedAt - b.joinedAt);
  for (const peer of peers) {
    const tile = buildTile({
      id: peer.id, name: peer.name, isSelf: false, muted: peer.muted,
      speaking: app.meters.get(peer.id)?.speaking || false,
      volume: peer.volume,
      onVolume: (v) => {
        peer.volume = v;
        if (peer.audio) peer.audio.volume = app.deafened ? 0 : v;
      },
    });
    app.tiles.set(peer.id, tile);
    grid.append(tile);
  }
  if (peers.length === 0) {
    grid.append(buildInviteTile());
  }
  grid.dataset.count = String(Math.min(peers.length + 1, 6));
  grid.classList.toggle('solo', peers.length === 0);
  $('#stage-count').textContent = `${peers.length + 1} 人在线`;
  if (app.me) $('#self-name').textContent = app.me.name;
  $('#self-avatar').textContent = initial(app.me?.name || '我');
  $('#self-avatar').style.setProperty('--hue', hueFor(app.me?.name || '我'));
  $('#self-state').textContent = app.listenOnly ? '只听模式' : app.muted ? '已静音' : app.settings.pttEnabled ? '按键说话' : '麦克风开启';
  $('#mic-btn').classList.toggle('muted', !micEnabled());
  $('#mic-btn').querySelector('use').setAttribute('href', !micEnabled() ? '#i-mic-off' : '#i-mic');
  $('#deafen-btn').classList.toggle('muted', app.deafened);
  $('#deafen-btn').querySelector('use').setAttribute('href', app.deafened ? '#i-headphones-off' : '#i-headphones');
  renderPtt();
}

function renderSelf() {
  const tile = app.tiles.get('self');
  if (tile) {
    const mic = tile.querySelector('.mic-state');
    if (mic) {
      mic.classList.toggle('muted', !micEnabled());
      mic.classList.toggle('live', micEnabled());
      const use = mic.querySelector('use');
      if (use) use.setAttribute('href', !micEnabled() ? '#i-mic-off' : '#i-mic');
    }
    tile.querySelector('.tile-meta').textContent = tileMeta(true);
  }
  if (!$('#mic-btn')) return;
  $('#mic-btn').classList.toggle('muted', !micEnabled());
  $('#mic-btn').querySelector('use').setAttribute('href', !micEnabled() ? '#i-mic-off' : '#i-mic');
  $('#self-state').textContent = app.listenOnly ? '只听模式' : app.muted ? '已静音' : app.settings.pttEnabled ? '按键说话' : '麦克风开启';
}

function buildTile({ id, name, isSelf, muted, speaking, volume = 1, onVolume }) {
  const tile = document.createElement('div');
  tile.className = 'tile' + (speaking ? ' speaking' : '');
  tile.dataset.id = id;

  const mic = document.createElement('span');
  mic.className = 'mic-state' + (muted ? ' muted' : ' live');
  mic.innerHTML = `<svg viewBox="0 0 24 24"><use href="${muted ? '#i-mic-off' : '#i-mic'}"/></svg>`;
  mic.title = muted ? '已静音' : '麦克风开启';
  tile.append(mic);

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.style.setProperty('--hue', hueFor(name));
  avatar.textContent = initial(name);
  tile.append(avatar);

  const nameWrap = document.createElement('div');
  nameWrap.className = 'tile-name';
  const b = document.createElement('b');
  b.textContent = name;
  nameWrap.append(b);
  if (isSelf) {
    const badge = document.createElement('span');
    badge.className = 'badge-you';
    badge.textContent = '你';
    nameWrap.append(badge);
  }
  tile.append(nameWrap);

  const meta = document.createElement('div');
  meta.className = 'tile-meta';
  meta.textContent = isSelf ? tileMeta(true) : tileMeta(false);
  tile.append(meta);

  if (!isSelf && onVolume) {
    const vol = document.createElement('div');
    vol.className = 'tile-vol';
    vol.innerHTML = '<svg viewBox="0 0 24 24"><use href="#i-headphones"/></svg>';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = '100';
    range.value = String(Math.round(volume * 100));
    range.setAttribute('aria-label', `调整 ${name} 的音量`);
    range.addEventListener('input', () => onVolume(Number(range.value) / 100));
    vol.append(range);
    tile.append(vol);
  }
  return tile;
}

function buildInviteTile() {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'tile';
  tile.style.borderStyle = 'dashed';
  tile.style.background = 'transparent';
  tile.innerHTML = '<div class="avatar" style="--hue:150;background:rgba(255,255,255,.04);color:var(--accent);box-shadow:none">＋</div>' +
    '<div class="tile-name"><b>邀请朋友</b></div><div class="tile-meta">复制链接，浏览器打开即用</div>';
  tile.addEventListener('click', copyInvite);
  return tile;
}

function tileMeta(isSelf) {
  if (isSelf) {
    if (app.listenOnly) return '只听模式';
    const q = QUALITY[app.settings.quality] || QUALITY.standard;
    return `${q.name} · ${q.kbps}kbps`;
  }
  return 'Opus · 48kHz';
}

function renderPtt() {
  const btn = $('#ptt-btn');
  if (!btn) return;
  btn.classList.toggle('active', app.settings.pttEnabled);
  btn.classList.toggle('live', app.pttHeld && app.settings.pttEnabled);
  btn.querySelector('kbd').textContent = pttKeyLabel();
}

function setConnState(state) {
  const dot = $('#conn-dot');
  const text = $('#conn-text');
  if (!dot) return;
  const map = {
    connecting: ['连接中…', ''],
    new: ['连接中…', ''],
    connected: ['已连接', 'online'],
    disconnected: ['重连中…', ''],
    failed: ['连接失败', 'offline'],
    closed: ['已断开', 'offline'],
    idle: ['未连接', ''],
  };
  const [label, cls] = map[state] || [state, ''];
  text.textContent = label;
  dot.className = 'conn-dot' + (cls ? ' ' + cls : '');
  if (state === 'failed' && app.joined) {
    toast('媒体连接失败，正在重连…', 'error');
    scheduleReconnect();
  }
}

function banner(title, text, action, fn) {
  const el = $('#banner');
  $('#banner-title').textContent = title;
  $('#banner-text').textContent = text;
  const btn = $('#banner-action');
  app.bannerAction = fn || null;
  if (action) {
    btn.textContent = action;
    btn.classList.remove('hidden');
  } else {
    btn.classList.add('hidden');
  }
  el.classList.remove('hidden');
}

function bannerHide() {
  $('#banner')?.classList.add('hidden');
}

async function unlockAudio() {
  try { await getAudioCtx().resume(); } catch { /* noop */ }
  for (const peer of app.peers.values()) {
    if (peer.audio) peer.audio.play().catch(() => {});
  }
}


/* ------------------------------------------------------------------ */
/* FLAC lossless side channel                                         */
/* ------------------------------------------------------------------ */

async function toggleFlac() {
  if (!app.joined) return;
  if (app.flac.sending) {
    stopFlac(true);
    return;
  }
  if (app.flac.active) {
    // We stopped listening locally but the sender is still live: resume.
    if (!app.flac.player && app.flac.active.id !== app.me?.id) {
      ensureFlacPlayer(app.flac.active);
      showFlacBar(false);
      return;
    }
    toast('房间里已经有人在发送无损音频', 'error');
    return;
  }
  if (app.listenOnly) {
    toast('只听模式不能发送无损音频', 'error');
    return;
  }
  if (app.muted || app.deafened) {
    toast('请先取消静音 / 闭音，再开启无损发送', 'error');
    return;
  }

  const btn = $('#flac-btn');
  btn.disabled = true;
  let sender = new FlacSender({
    deviceId: app.settings.inputId,
    onChunk: (bytes) => {
      if (!app.flac.sending) return;
      sendBinary(bytes);
      app.flac.sentBytes += bytes.byteLength;
      app.flac.sentChunks++;
    },
    onError: (err) => {
      toast('无损编码失败：' + humanError(err), 'error');
      stopFlac(true);
    },
    onLog: (line) => console.debug('[flac]', line),
  });

  let fmt;
  try {
    fmt = await sender.start();
  } catch (err) {
    // Fall back to the microphone we already hold (may include browser DSP).
    if (app.localStream) {
      sender.stop();
      sender = new FlacSender({
        stream: app.localStream,
        onChunk: (bytes) => {
          if (!app.flac.sending) return;
          sendBinary(bytes);
          app.flac.sentBytes += bytes.byteLength;
          app.flac.sentChunks++;
        },
        onError: (e) => {
          toast('无损编码失败：' + humanError(e), 'error');
          stopFlac(true);
        },
      });
      try {
        fmt = await sender.start();
        toast('已使用当前麦克风（可能带处理）发送无损音频', 'ok');
      } catch (err2) {
        sender.stop();
        btn.disabled = false;
        toast('无法启动无损通道：' + humanError(err2), 'error');
        return;
      }
    } else {
      btn.disabled = false;
      toast('无法启动无损通道：' + humanError(err), 'error');
      return;
    }
  }

  app.flac.sender = sender;
  app.flac.sending = true;
  app.flac.sentBytes = 0;
  app.flac.sentChunks = 0;
  app.flac.startedAt = performance.now();
  app.flac.active = null;
  app.flac.format = { ...fmt };
  send({ t: 'flac-start', ...fmt });
  showFlacBar(true);
  updateFlacButton();
  btn.disabled = false;
  toast(`FLAC 无损发送已开启 · ${(fmt.sampleRate / 1000).toFixed(1)} kHz`, 'ok');
}

function hardStopFlacSender() {
  if (app.flac.sender) {
    try { app.flac.sender.stop(); } catch { /* noop */ }
    app.flac.sender = null;
  }
  app.flac.sending = false;
}

function stopFlac(notify) {
  const wasSending = app.flac.sending;
  hardStopFlacSender();
  if (notify && wasSending) send({ t: 'flac-stop' });
  if (!app.flac.active) {
    hideFlacBar();
  }
  updateFlacButton();
}

function stopListeningFlac() {
  if (app.flac.player) {
    app.flac.player.close();
    app.flac.player = null;
  }
  hideFlacBar();
  updateFlacButton();
}

function resetFlac() {
  hardStopFlacSender();
  if (app.flac.player) {
    app.flac.player.close();
    app.flac.player = null;
  }
  app.flac.active = null;
  app.flac.format = null;
  app.flac.sentBytes = 0;
  app.flac.sentChunks = 0;
  app.flac.startedAt = 0;
  clearInterval(app.flac.timer);
  app.flac.timer = null;
  hideFlacBar();
  updateFlacButton();
}

function ensureFlacPlayer(active) {
  if (app.flac.player) {
    app.flac.player.close();
    app.flac.player = null;
  }
  app.flac.player = new FlacPlayer({
    sampleRate: active.sampleRate,
    onError: (err) => console.debug('[flac] decode', err),
  });
  $('#flac-volume').value = '100';
  app.flac.player.setVolume(1);
}

function onFlacStarted(msg) {
  const fmt = {
    sampleRate: msg.sampleRate,
    channels: msg.channels,
    bits: msg.bits,
    chunkMs: msg.chunkMs,
  };
  app.flac.format = fmt;
  if (msg.peer && msg.peer.id === app.me?.id) {
    app.flac.sending = true;
    app.flac.startedAt = app.flac.startedAt || performance.now();
    showFlacBar(true);
  } else {
    if (app.flac.sending) stopFlac(true);
    app.flac.active = {
      id: msg.peer.id,
      name: msg.peer.name,
      ...fmt,
    };
    ensureFlacPlayer(app.flac.active);
    app.flac.startedAt = performance.now();
    applyVolume();
    showFlacBar(false);
    toast(`${msg.peer.name} 开始发送 FLAC 无损`, 'ok');
  }
  updateFlacButton();
}

function onFlacStopped(msg) {
  if (msg.id === app.me?.id) {
    hardStopFlacSender();
  }
  if (app.flac.active && app.flac.active.id === msg.id) {
    if (app.flac.player) {
      app.flac.player.close();
      app.flac.player = null;
    }
    app.flac.active = null;
    hideFlacBar();
  }
  if (!app.flac.sending && !app.flac.active) hideFlacBar();
  updateFlacButton();
}

function onFlacBinary(data) {
  if (!app.flac.player || !app.flac.active) return;
  if (!(data instanceof ArrayBuffer)) return;
  app.flac.player.push(data);
}

function showFlacBar(self) {
  const bar = $('#flac-bar');
  const fmt = app.flac.format;
  if (!bar || !fmt) return;
  $('#flac-title').textContent = self
    ? '你正在发送 · FLAC 无损'
    : `${app.flac.active?.name || '有人'} · FLAC 无损`;
  const volume = $('#flac-volume');
  volume.style.display = self ? 'none' : '';
  $('#flac-action').textContent = self ? '停止发送' : '停止收听';
  bar.classList.remove('hidden');
  updateFlacMeta();
  clearInterval(app.flac.timer);
  app.flac.timer = setInterval(updateFlacMeta, 1000);
  updateFlacButton();
}

function hideFlacBar() {
  $('#flac-bar')?.classList.add('hidden');
  clearInterval(app.flac.timer);
  app.flac.timer = null;
  updateFlacButton();
}

function updateFlacMeta() {
  const fmt = app.flac.format;
  if (!fmt) return;
  let bytes = 0;
  if (app.flac.sending) bytes = app.flac.sentBytes;
  else if (app.flac.player) bytes = app.flac.player.bytes;
  const elapsed = app.flac.startedAt ? (performance.now() - app.flac.startedAt) / 1000 : 0;
  const kbps = elapsed > 0.5 ? (bytes * 8) / 1000 / elapsed : 0;
  const rate = kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`;
  const ch = fmt.channels === 2 ? '立体声' : '单声道';
  $('#flac-meta').textContent =
    `${(fmt.sampleRate / 1000).toFixed(1)} kHz · ${ch} · ${fmt.bits}-bit · ${rate}`;
}

function updateFlacButton() {
  const btn = $('#flac-btn');
  if (!btn) return;
  btn.classList.toggle('active', app.flac.sending || !!app.flac.active);
  btn.classList.toggle('muted', false);
  btn.title = app.flac.sending ? '停止 FLAC 无损发送' : 'FLAC 无损旁路（约 1 Mbps，延迟约 0.8 秒）';
}

function sendBinary(data) {
  if (app.ws?.readyState === WebSocket.OPEN) app.ws.send(data);
}

/* ------------------------------------------------------------------ */
/* chat                                                               */
/* ------------------------------------------------------------------ */

function addChat(chat) {
  const log = $('#chat-log');
  if (!log) return;
  if (log.querySelector('.chat-empty')) log.replaceChildren();
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  const wrap = document.createElement('div');
  wrap.className = 'msg' + (chat.fromId === app.me?.id ? ' mine' : '') + (chat.system ? ' system' : '');
  const p = document.createElement('p');
  p.textContent = chat.text;
  if (chat.system) {
    wrap.append(p);
  } else {
    const head = document.createElement('div');
    head.className = 'msg-head';
    const b = document.createElement('b');
    b.textContent = chat.from;
    const time = document.createElement('time');
    time.textContent = new Date(chat.ts || Date.now()).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    head.append(b, time);
    wrap.append(head, p);
  }
  log.append(wrap);
  const max = 200;
  while (log.children.length > max) log.firstElementChild.remove();
  if (nearBottom) log.scrollTop = log.scrollHeight;
}

function fileDownloadURL(file) {
  return `/api/files/${encodeURIComponent(file.id)}?token=${encodeURIComponent(app.fileToken)}`;
}

function renderFiles() {
  const list = $('#file-list');
  if (!list) return;
  if (!app.joined || !app.files.length || !app.fileToken) {
    list.classList.add('hidden');
    list.replaceChildren();
    return;
  }
  list.classList.remove('hidden');
  list.replaceChildren();
  for (const f of app.files) {
    const a = document.createElement('a');
    a.className = 'file-card';
    a.href = fileDownloadURL(f);
    a.download = f.name;
    a.title = `下载 ${f.name}`;
    a.innerHTML = '<span class="fi"><svg><use href="#i-paperclip"/></svg></span>';
    const meta = document.createElement('span');
    meta.className = 'fm';
    const name = document.createElement('b');
    name.textContent = f.name;
    const sub = document.createElement('small');
    const time = new Date(f.ts || Date.now()).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    sub.textContent = `${formatBytes(f.size)} · ${f.from} · ${time}`;
    meta.append(name, sub);
    const dl = document.createElement('svg');
    dl.innerHTML = '<use href="#i-download"/>';
    a.append(meta, dl);
    list.append(a);
  }
}

function setFileProgress(pct, text) {
  const box = $('#file-progress');
  if (!box) return;
  box.classList.remove('hidden');
  const bar = box.querySelector('i');
  const label = box.querySelector('span');
  if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
  if (label) label.textContent = text;
}

function hideFileProgressSoon() {
  const box = $('#file-progress');
  if (!box) return;
  setTimeout(() => {
    if (!app.uploading) {
      box.classList.add('hidden');
      const bar = box.querySelector('i');
      if (bar) bar.style.width = '0%';
    }
  }, 900);
}

async function uploadFiles(files) {
  if (!files.length || !app.joined) return;
  if (app.uploading) return toast('正在上传，请稍候', 'error');
  app.uploading = true;
  const btn = $('#file-btn');
  if (btn) btn.disabled = true;
  try {
    for (const file of files) {
      const maxMB = Number(app.info?.maxFileMB || 100);
      if (file.size > maxMB * 1024 * 1024) {
        toast(`${file.name} 超过 ${maxMB} MB 上限`, 'error');
        continue;
      }
      await uploadOne(file);
    }
  } finally {
    app.uploading = false;
    if (btn) btn.disabled = !app.joined;
    hideFileProgressSoon();
  }
}

function uploadOne(file) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('file', file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/files/upload?room=${encodeURIComponent(app.room)}`);
    xhr.setRequestHeader('Authorization', 'Bearer ' + app.token);
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = (e.loaded / e.total) * 100;
      setFileProgress(pct, `正在上传 ${file.name} · ${Math.round(pct)}%`);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        setFileProgress(100, `${file.name} 上传完成`);
        resolve();
        return;
      }
      let message = '上传失败';
      try { message = JSON.parse(xhr.responseText).error || xhr.responseText || message; } catch { /* plain */ }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error('上传失败：网络错误'));
    xhr.onabort = () => reject(new Error('上传已取消'));
    setFileProgress(0, `准备上传 ${file.name}…`);
    xhr.send(fd);
    xhr.onloadend = () => {};
  }).catch((err) => {
    toast(err.message || '上传失败', 'error');
  });
}

const SCREEN_FPS = [30, 60, 90, 120];
const SCREEN_HEIGHTS = [720, 1080, 1440];
const SCREEN_BITRATES = [1000, 2000, 4000, 8000];

function screenSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
}

function updateScreenButton() {
  const btn = $('#screen-btn');
  if (!btn) return;
  const active = !!app.screen.active;
  btn.disabled = !app.joined || !screenSupported();
  btn.classList.toggle('active', active);
  btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  btn.title = !screenSupported()
    ? '此浏览器不支持桌面共享'
    : active
      ? (app.screen.owner ? '正在共享桌面' : '正在观看桌面')
      : '桌面共享';
}

function renderScreenOptions() {
  // Drop old 2/5/10/15 selections from localStorage.
  if (!SCREEN_FPS.includes(Number(app.settings.screenFps))) {
    app.settings.screenFps = 30;
    store.set('screenFps', 30);
  }
  const groups = [
    ['#sf-fps', SCREEN_FPS, Number(app.settings.screenFps), (v) => `${v} fps`, 'screenFps'],
    ['#sf-height', SCREEN_HEIGHTS, Number(app.settings.screenHeight), (v) => `${v}p`, 'screenHeight'],
    ['#sf-bitrate', SCREEN_BITRATES, Number(app.settings.screenBitrate), (v) => `${v / 1000} Mbps`, 'screenBitrate'],
  ];
  for (const [sel, values, current, label, key] of groups) {
    const box = $(sel);
    if (!box) continue;
    box.replaceChildren();
    for (const v of values) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip' + (v === current ? ' active' : '');
      btn.textContent = label(v);
      btn.addEventListener('click', () => {
        app.settings[key] = v;
        store.set(key, v);
        renderScreenOptions();
      });
      box.append(btn);
    }
  }
}

function openScreenOptions() {
  if (!app.joined) return;
  if (!screenSupported()) {
    toast('当前浏览器不支持桌面共享，请用桌面版 Chrome / Edge', 'error');
    return;
  }
  renderScreenOptions();
  $('#screen-modal').classList.remove('hidden');
}

function closeScreenOptions() {
  $('#screen-modal').classList.add('hidden');
}

function clampNumber(v, lo, hi, def) {
  if (!Number.isFinite(v)) return def;
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

async function startScreenShare() {
  if (!app.joined || !app.link) return;
  if (!screenSupported()) {
    toast('当前浏览器不支持桌面共享', 'error');
    return;
  }
  const fps = clampNumber(Number(app.settings.screenFps), 30, 120, 30);
  const height = clampNumber(Number(app.settings.screenHeight), 360, 2160, 1080);
  const bitrate = clampNumber(Number(app.settings.screenBitrate), 256, 20000, 4000);
  closeScreenOptions();
  resetScreen();

  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: fps, max: fps },
        width: { ideal: 2560 },
        height: { ideal: height, max: height },
      },
      audio: false,
    });
  } catch (err) {
    if (err && err.name !== 'NotAllowedError') toast('无法开始共享：' + (err.message || err.name), 'error');
    return;
  }
  const track = stream.getVideoTracks()[0];
  if (!track) {
    stream.getTracks().forEach((t) => t.stop());
    toast('没有获取到屏幕画面', 'error');
    return;
  }
  const video = $('#screen-video');
  video.srcObject = stream;
  app.screen.active = true;
  app.screen.owner = true;
  app.screen.pending = true;
  app.screen.stream = stream;
  app.screen.track = track;
  app.screen.video = video;
  app.screen.info = null;
  showScreenPanel();
  video.hidden = false;
  $('#screen-stop').hidden = false;
  $('#screen-title').textContent = '我的桌面共享';
  $('#screen-meta').textContent = `目标 ${fps} fps · ≤ ${(bitrate / 1000).toFixed(1)} Mbps`;
  $('#screen-status').textContent = '正在建立 WebRTC 视频连接…';
  updateScreenButton();
  try { await video.play(); } catch { /* muted autoplay */ }
  startScreenFpsMeter();
  const settings = track.getSettings ? track.getSettings() : {};
  const width = Math.round(settings.width || video.videoWidth || 1280);
  const realHeight = Math.round(settings.height || video.videoHeight || height);
  // Register the share before adding the video transceiver; the server uses this
  // metadata to allow the RTP source and to show the panel to the room.
  send({ t: 'screen-start', width, height: realHeight, fps, screenBitrate: bitrate });
  track.addEventListener('ended', () => stopScreenShare(true));
  app.screen.pendingTimer = setTimeout(() => {
    if (app.screen.pending) {
      stopScreenShare(true);
      toast('桌面共享启动超时', 'error');
    }
  }, 8000);
  try {
    await app.link.startScreen(track, {
      maxBitrate: bitrate * 1000,
      maxFramerate: fps,
    });
  } catch (err) {
    stopScreenShare(true);
    toast('桌面视频启动失败：' + (err.message || err), 'error');
  }
}

function onScreenStarted(info) {
  if (!app.joined || !info || !info.peer) return;
  if (info.peer.id === app.me?.id) {
    if (!app.screen.owner) return;
    clearTimeout(app.screen.pendingTimer);
    app.screen.pending = false;
    app.screen.info = info;
    showScreenPanel();
    updateScreenButton();
    $('#screen-status').textContent = `WebRTC 视频 · ${info.width}×${info.height} · 目标 ${info.fps} fps`;
    return;
  }
  if (app.screen.owner) return; // server would reject a second sharer
  startScreenViewer(info);
}

function onScreenStopped(id) {
  if (!app.screen.active) return;
  const wasOwner = app.screen.owner;
  if (wasOwner && app.me?.id === id) {
    stopScreenShare(false);
    return;
  }
  if (app.screen.info?.peer?.id === id) {
    const name = app.screen.info.peer.name || '对方';
    resetScreen();
    toast(`${name} 停止了桌面共享`, 'ok');
  }
}

function onScreenTrack(peerId, stream) {
  // A video track can arrive just before the screen-started JSON. Keep it so
  // startScreenViewer can attach it immediately.
  app.screen.remoteStream = stream;
  app.screen.remotePeer = peerId;
  if (!app.screen.active || app.screen.owner) return;
  if (app.screen.info && app.screen.info.peer.id !== peerId) return;
  attachScreenStream(stream);
}

function attachScreenStream(stream) {
  const video = $('#screen-video');
  if (!video || !stream) return;
  app.screen.stream = stream;
  app.screen.video = video;
  video.srcObject = stream;
  video.hidden = false;
  $('#screen-img').hidden = true;
  showScreenPanel();
  startScreenFpsMeter();
  const info = app.screen.info;
  if (info) {
    $('#screen-status').textContent = `WebRTC 视频 · ${info.width}×${info.height} · 目标 ${info.fps} fps`;
  }
}

function showScreenPanel() {
  if (!app.screen.active) return;
  $('#screen-panel').classList.remove('hidden');
  const video = $('#screen-video');
  video.hidden = false;
  $('#screen-img').hidden = true;
  $('#screen-stop').hidden = !app.screen.owner;
  if (app.screen.stream) video.play().catch(() => {});
}

function hideScreenPanel() {
  $('#screen-panel').classList.add('hidden');
  const video = $('#screen-video');
  if (video && !app.screen.owner) {
    // Stop decoding while the viewer has the panel closed; reattaching the
    // stream on reopen starts again.
    video.pause();
  }
}

function startScreenFpsMeter() {
  const video = $('#screen-video');
  if (!video || !('requestVideoFrameCallback' in video)) return;
  if (app.screen.fpsMeterRunning) return;
  app.screen.fpsMeterRunning = true;
  app.screen.frameCount = 0;
  app.screen.fpsAt = performance.now();
  const tick = () => {
    if (!app.screen.active || !app.screen.stream) {
      app.screen.fpsMeterRunning = false;
      return;
    }
    app.screen.frameCount++;
    const now = performance.now();
    if (now - app.screen.fpsAt >= 1000) {
      const actual = Math.round((app.screen.frameCount * 1000) / Math.max(1, now - app.screen.fpsAt));
      app.screen.frameCount = 0;
      app.screen.fpsAt = now;
      const info = app.screen.info;
      if (info) {
        $('#screen-status').textContent = `WebRTC 视频 · ${info.width}×${info.height} · 目标 ${info.fps} fps · 实际 ${actual} fps`;
      }
    }
    video.requestVideoFrameCallback(tick);
  };
  video.requestVideoFrameCallback(tick);
}

async function stopScreenShare(notify) {
  const wasOwner = app.screen.owner && app.screen.active;
  if (wasOwner && notify !== false) send({ t: 'screen-stop' });
  const link = app.link;
  resetScreen();
  if (wasOwner && link) {
    try { await link.stopScreen(); } catch { /* audio rebuild best-effort */ }
  }
}

function resetScreen() {
  const s = app.screen;
  clearTimeout(s.pendingTimer);
  if (s.stream) s.stream.getTracks().forEach((t) => t.stop());
  if (s.video) {
    try { s.video.pause(); } catch { /* noop */ }
    s.video.srcObject = null;
  }
  app.screen = {
    active: false,
    owner: false,
    pending: false,
    info: null,
    stream: null,
    track: null,
    video: s.video || null,
    pendingTimer: null,
    fpsMeterRunning: false,
    frameCount: 0,
    fpsAt: 0,
    remoteStream: null,
    remotePeer: '',
  };
  const panel = $('#screen-panel');
  if (panel) panel.classList.add('hidden');
  const video = $('#screen-video');
  const img = $('#screen-img');
  if (video) video.hidden = true;
  if (img) { img.hidden = true; img.removeAttribute('src'); }
  const stop = $('#screen-stop');
  if (stop) stop.hidden = true;
  updateScreenButton();
}

function startScreenViewer(info) {
  if (!app.joined || !info || !info.peer || info.peer.id === app.me?.id) return;
  const pendingStream = app.screen.remoteStream;
  const pendingPeer = app.screen.remotePeer;
  resetScreen();
  app.screen.active = true;
  app.screen.owner = false;
  app.screen.info = info;
  app.screen.video = $('#screen-video');
  $('#screen-title').textContent = `${info.peer.name} 的桌面`;
  $('#screen-meta').textContent = `${info.width}×${info.height} · 目标 ${info.fps} fps · ≤ ${(info.bitrate / 1000).toFixed(1)} Mbps`;
  $('#screen-status').textContent = '等待 WebRTC 视频…';
  $('#screen-video').hidden = false;
  $('#screen-stop').hidden = true;
  showScreenPanel();
  updateScreenButton();
  if (pendingStream && (!pendingPeer || pendingPeer === info.peer.id)) {
    app.screen.remoteStream = pendingStream;
    app.screen.remotePeer = pendingPeer;
    attachScreenStream(pendingStream);
  }
}

function addSystem(text) {
  addChat({ from: '系统', fromId: 'system', text, ts: Date.now(), system: true });
}

function renderChatEmpty(text) {
  const log = $('#chat-log');
  log.replaceChildren();
  const d = document.createElement('div');
  d.className = 'chat-empty';
  d.innerHTML = text || '这里还没有消息<br>打个招呼吧';
  log.append(d);
}

/* ------------------------------------------------------------------ */
/* settings                                                           */
/* ------------------------------------------------------------------ */

async function openSettings() {
  syncHardwareToggles();
  renderQualityOptions($('#settings-quality'), true);
  await refreshDevices(true);
  $('#settings-modal').classList.remove('hidden');
  renderDiag(null);
  if (app.link) {
    const s = await app.link.stats();
    renderDiag(s);
  }
}

function closeSettings() {
  $('#settings-modal').classList.add('hidden');
}

async function applySettings() {
  if (app.flac.sending) stopFlac(true);
  app.settings.ec = $('#ec-toggle').checked;
  app.settings.ns = $('#ns-toggle').checked;
  app.settings.agc = $('#agc-toggle').checked;
  app.settings.sounds = $('#sounds-toggle').checked;
  app.settings.pttKey = $('#ptt-key').dataset.value || 'v';
  app.settings.inputId = $('#input-device').dataset.value || '';
  app.settings.outputId = $('#output-device').dataset.value || '';
  for (const k of ['ec', 'ns', 'agc', 'sounds', 'pttKey', 'inputId', 'outputId']) store.set(k, app.settings[k]);
  syncHardwareToggles();
  updateQualityBadge();
  renderPtt();
  closeSettings();

  if (!app.joined) return toast('设置已保存', 'ok');
  const q = QUALITY[app.settings.quality] || QUALITY.standard;
  send({ t: 'quality', bitrate: q.kbps });

  try {
    if (!app.listenOnly) {
      const stream = await ensureMic();
      if (app.link) await app.link.rebuild(stream, q.kbps);
    } else if (app.link) {
      await app.link.rebuild(null, q.kbps);
    }
    applyVolume();
    applyMicGate();
    toast(`已应用：${q.name} · ${q.kbps}kbps`, 'ok');
  } catch (err) {
    toast('应用失败：' + humanError(err), 'error');
  }
}

async function refreshDevices(force) {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  if (!force && app._devicesLoaded) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = dedupeDevices(devices.filter((d) => d.kind === 'audioinput'), app.settings.inputId);
  const outputs = dedupeDevices(devices.filter((d) => d.kind === 'audiooutput'), app.settings.outputId);
  renderDevicePicker($('#input-device'), inputs, '默认麦克风（跟随系统）', app.settings.inputId, 'input');
  renderDevicePicker($('#output-device'), outputs, '系统默认输出', app.settings.outputId, 'output');
  app._devicesLoaded = true;
}

// Windows exposes the same physical device three times (default, communications
// and raw endpoint). Keep one entry per physical device and pick the raw
// endpoint unless the user explicitly selected one of the others.
function normalizeDeviceLabel(label) {
  return String(label || '')
    .trim()
    .replace(/^(默认|通讯|通信|Default|Communications?)\s*[-–—:：]\s*/i, '')
    .replace(/\s*\(\s*[0-9a-f]{4}:[0-9a-f]{4}\s*\)\s*$/i, '')
    .trim();
}

function dedupeDevices(devices, chosen) {
  const groups = new Map();
  for (const d of devices) {
    const label = normalizeDeviceLabel(d.label);
    const key = d.groupId || (label ? label : d.deviceId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }
  const out = [];
  for (const members of groups.values()) {
    let rep = members.find((d) => d.deviceId === chosen);
    if (!rep) {
      const score = (d) => (/^(默认|通讯|通信|Default|Communications?)\s*[-–—:：]/i.test(d.label || '') ? 2 : 1);
      rep = [...members].sort((a, b) => score(a) - score(b))[0];
    }
    out.push(rep);
  }
  const seen = new Map();
  return out.map((d, i) => {
    const base = normalizeDeviceLabel(d.label) || (d.kind === 'audioinput' ? '麦克风' : '音频输出');
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return { ...d, displayLabel: n > 1 ? `${base} · ${n}` : base };
  });
}

function renderDevicePicker(container, devices, fallback, chosen, kind) {
  if (!container) return;
  const items = [
    { id: '', label: fallback, note: '系统默认' },
    ...devices.map((d) => ({
      id: d.deviceId,
      label: d.displayLabel || d.label || '音频设备',
      note: kind === 'input' ? '输入' : '输出',
    })),
  ];
  const valid = chosen && items.some((item) => item.id === chosen) ? chosen : '';
  container.dataset.value = valid;
  container.replaceChildren();
  for (const item of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'device-option' + (item.id === valid ? ' active' : '');
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', item.id === valid ? 'true' : 'false');
    const radio = document.createElement('span');
    radio.className = 'radio';
    const label = document.createElement('span');
    label.textContent = item.label;
    label.style.overflow = 'hidden';
    label.style.textOverflow = 'ellipsis';
    label.style.whiteSpace = 'nowrap';
    const note = document.createElement('small');
    note.textContent = item.note;
    btn.append(radio, label, note);
    btn.addEventListener('click', () => {
      container.dataset.value = item.id;
      renderDevicePicker(container, devices, fallback, item.id, kind);
    });
    container.append(btn);
  }
}

function renderDiag(stats) {
  const box = $('#diag');
  if (!box) return;
  if (!stats) {
    box.innerHTML = '<div class="diag-row ghost"><span>等待音频…</span></div>';
    $('#diag-meta').textContent = '—';
    return;
  }
  box.replaceChildren();
  const head = document.createElement('div');
  head.className = 'diag-row head';
  head.innerHTML = '<span>参与者</span><span>码率</span><span>抖动</span><span>丢包</span>';
  box.append(head);
  const names = new Map([...app.peers.values()].map((p) => [p.id, p.name]));
  if (!stats.peers.length) {
    const row = document.createElement('div');
    row.className = 'diag-row ghost';
    row.innerHTML = '<span>尚未收到音频</span><span>—</span><span>—</span><span>—</span>';
    box.append(row);
  }
  for (const p of stats.peers) {
    const row = document.createElement('div');
    row.className = 'diag-row';
    const name = names.get(p.peerId) || shortId(p.peerId) || '未知';
    const loss = p.lossPct != null ? p.lossPct.toFixed(1) + '%' : '—';
    row.innerHTML = `<span>${escapeHtml(name)}</span><span>${p.kbps}k</span><span>${Math.round((p.jitter || 0) * 1000)}ms</span><span>${loss}</span>`;
    box.append(row);
  }
  const rss = app.serverStats ? formatBytes(app.serverStats.rssBytes) : '—';
  const parts = [
    `RTT ${stats.rtt != null ? Math.round(stats.rtt) + 'ms' : '—'}`,
    `上行 ${Math.round(stats.outKbps || 0)}k`,
    `下行 ${Math.round(stats.inKbps || 0)}k`,
    `服务端 ${rss}`,
  ];
  $('#diag-meta').textContent = parts.join(' · ');
}

/* ------------------------------------------------------------------ */
/* invite + helpers                                                   */
/* ------------------------------------------------------------------ */

async function copyInvite() {
  const url = `${location.origin}/?room=${encodeURIComponent(app.room || '大厅')}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('邀请链接已复制', 'ok');
  } catch {
    prompt('复制这个链接发给朋友', url);
  }
}

function send(msg) {
  if (app.ws?.readyState === WebSocket.OPEN) app.ws.send(JSON.stringify(msg));
}

function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = text;
  $('#toasts').append(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .25s';
    setTimeout(() => el.remove(), 260);
  }, 3200);
}

function humanError(err) {
  if (!err) return '未知错误';
  const name = err.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return '麦克风权限被拒绝';
  if (name === 'NotFoundError') return '没有找到麦克风';
  if (name === 'NotReadableError') return '麦克风被其他程序占用';
  if (name === 'OverconstrainedError') return '所选设备不可用';
  return err.message || String(err);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function shortId(id) {
  return id ? id.slice(0, 4) : '?';
}

function initial(name) {
  const s = (name || '?').trim();
  const chars = [...s];
  if (!chars.length) return '?';
  if (/[\u3400-\u9fff]/.test(chars[0])) return chars.slice(0, 2).join('');
  return chars[0].toUpperCase();
}

function hueFor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return (h % 45) + 135; // mint to teal, never purple
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

renderChatEmpty();

/* test + debugging hook */
function syncTestHook() {
  window.qy = {
    app,
    get joined() { return app.joined; },
    get loggedIn() { return app.loggedIn; },
    get room() { return app.room; },
    get me() { return app.me; },
    get peers() { return [...app.peers.values()]; },
    get link() { return app.link; },
    get localStream() { return app.localStream; },
    get micEnabled() { return micEnabled(); },
    get flac() {
      return {
        sending: app.flac.sending,
        active: app.flac.active,
        format: app.flac.format,
        sentBytes: app.flac.sentBytes,
        sentChunks: app.flac.sentChunks,
        player: app.flac.player ? app.flac.player.stats() : null,
      };
    },
    startFlac: toggleFlac,
    stopFlac: () => stopFlac(true),
    get meters() { return [...app.meters.entries()].map(([id, m]) => ({ id, speaking: m.speaking, level: m.level })); },
    async stats() { return app.link ? app.link.stats() : null; },
    login,
    enterRoom: (name, password = '') => enterOrSwitch(name, password, false),
    createRoom: (name, password = '') => prepareRoom(name, password, true),
    leaveRoom: () => leaveRoom(),
    logout,
    sendChat: (text) => send({ t: 'chat', text }),
    setMuted: (v) => { app.muted = !!v; applyMicGate(); sendState(); },
    playCue: (kind = 'enter') => playCue(kind),
    togglePtt: () => { app.settings.pttEnabled = !app.settings.pttEnabled; renderPtt(); },
  };
}
syncTestHook();
