// play.js  —  v4
// Loaded by play.html via <script src="/play.js">

// ── Persistent identity ───────────────────────────────────────
// Stored in localStorage so it survives page refreshes, phone
// lock screens, app switching, and hours of inactivity.
const LS_KEY = 'buzzer_player_session';

function loadSession()  { try { return JSON.parse(localStorage.getItem(LS_KEY)); } catch { return null; } }
function saveSession(s) { localStorage.setItem(LS_KEY, JSON.stringify(s)); }
function clearSession() { localStorage.removeItem(LS_KEY); }

function getOrCreatePersistentId() {
  const s = loadSession();
  if (s && s.id) return s.id;
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  saveSession({ id });
  return id;
}

const PERSISTENT_ID = getOrCreatePersistentId();

// ── Runtime state ─────────────────────────────────────────────
let myPlayerId = null;
let roomCode   = null;
let myName     = null;
let joined     = false;

// ── Socket (long-lived, auto-reconnect) ───────────────────────
const socket = io({
  reconnection        : true,
  reconnectionAttempts: Infinity,
  reconnectionDelay   : 1000,
  reconnectionDelayMax: 8000,
});

// ── Sounds ────────────────────────────────────────────────────
const AC = typeof AudioContext !== 'undefined' ? new AudioContext() : null;
function tone(f, d, t = 'sine', v = .35) {
  if (!AC) return;
  if (AC.state === 'suspended') AC.resume();
  const o = AC.createOscillator(), g = AC.createGain();
  o.type = t; o.frequency.value = f;
  g.gain.setValueAtTime(v, AC.currentTime);
  g.gain.exponentialRampToValueAtTime(.001, AC.currentTime + d);
  o.connect(g); g.connect(AC.destination);
  o.start(); o.stop(AC.currentTime + d);
}
function soundPress()  { tone(320, .12, 'square', .4); }
function soundWinner() { [523, 659, 784].forEach((f, i) => setTimeout(() => tone(f, .3, 'sine', .45), i * 140)); }
function soundReset()  { tone(440, .2); setTimeout(() => tone(550, .15), 80); }

// ── Helpers ───────────────────────────────────────────────────
function statusLabel(s) {
  return { winner: '🏆 فائز', ready: '✅ جاهز', 'too-late': '⛔ تأخر', offline: '🔴 غائب', wrong: '❌ خطأ' }[s] || s;
}
function statusClass(s) {
  return { winner: 'status-winner', ready: 'status-ready', 'too-late': 'status-too-late', offline: 'status-offline', wrong: 'status-wrong' }[s] || '';
}
function setMsg(m) {
  const el = document.getElementById('player-msg');
  if (!el) return;
  el.style.opacity = '0';
  setTimeout(() => { el.textContent = m; el.style.opacity = '1'; }, 200);
}

// ─────────────────────────────────────────────────────────────
// Auto-rejoin on every socket connect (including reconnects).
//
// Case 1 — mid-game socket loss (phone locked, app-switched):
//   joined=true, roomCode+myName in memory → silent rejoin.
//
// Case 2 — fresh page load with a saved session:
//   joined=false, check localStorage → pre-fill form + silent rejoin.
//   If the room is still alive the player is restored instantly;
//   if not, the server returns room:error and we clear the stale session.
// ─────────────────────────────────────────────────────────────
socket.on('connect', () => {
  if (joined && roomCode && myName) {
    socket.emit('player:join', { name: myName, roomCode, persistentId: PERSISTENT_ID });
  } else {
    const session = loadSession();
    if (session && session.id && session.roomCode && session.name) {
      document.getElementById('player-name').value = session.name;
      document.getElementById('join-code').value   = session.roomCode;
      socket.emit('player:join', {
        name        : session.name,
        roomCode    : session.roomCode,
        persistentId: session.id,
      });
    }
  }
});

// ── Manual join (form submit) ─────────────────────────────────
function joinGame() {
  const name  = document.getElementById('player-name').value.trim().slice(0, 30);
  const code  = document.getElementById('join-code').value.trim();
  const errEl = document.getElementById('join-error');
  errEl.textContent = '';

  if (!name) { errEl.textContent = 'أدخل اسمك.'; return; }
  if (!/^\d{4}$/.test(code)) { errEl.textContent = 'الرمز يجب أن يكون 4 أرقام.'; return; }

  saveSession({ id: PERSISTENT_ID, name, roomCode: code });
  socket.emit('player:join', { name, roomCode: code, persistentId: PERSISTENT_ID });
}

// ── Buzz ──────────────────────────────────────────────────────
function buzz() {
  soundPress();
  socket.emit('player:buzz', { roomCode, sentAt: Date.now() });
}

// ─────────────────────────────────────────────────────────────
// Socket events
// ─────────────────────────────────────────────────────────────

// Server confirms identity (join or rejoin)
socket.on('player:self', (player) => {
  myPlayerId = player.id;
  myName     = player.name;
  joined     = true;

  // Resolve roomCode (could come from form, memory, or saved session)
  if (!roomCode) {
    const codeInput = document.getElementById('join-code').value.trim();
    const session   = loadSession();
    roomCode = codeInput || (session && session.roomCode) || '';
  }

  saveSession({ id: PERSISTENT_ID, name: myName, roomCode });

  document.getElementById('p-name').textContent      = player.name;
  document.getElementById('p-room-code').textContent = roomCode;
  document.getElementById('view-join').style.display  = 'none';
  document.getElementById('view-play').style.display  = 'flex';
});

socket.on('room:error', (msg) => {
  if (joined) {
    // Already in play view — show inline
    setMsg('⚠️ ' + msg);
  } else {
    document.getElementById('join-error').textContent = msg;
    // Room no longer exists — clear stale session so the form stays clean
    if (msg.includes('لا توجد غرفة')) {
      clearSession();
      document.getElementById('player-name').value = '';
      document.getElementById('join-code').value   = '';
    }
  }
});

// Full game snapshot — sent on (re)join and on every state change
socket.on('game:state', (state) => {
  if (state.gameName) document.getElementById('p-game-name').textContent = state.gameName;
  if (!roomCode && state.roomCode) {
    roomCode = state.roomCode;
    document.getElementById('p-room-code').textContent = roomCode;
  }
  render(state);
});

socket.on('round:winner', ({ winnerId, winnerName }) => {
  if (winnerId === myPlayerId) {
    setMsg('🎉 أنت الأول! انتظر قرار المدير');
    soundWinner();
  } else {
    setMsg('⛔ ' + winnerName + ' ضغط أولاً!');
  }
});

socket.on('round:active-flash', () => {
  soundReset();
  const bz = document.getElementById('buzzer');
  if (bz) { bz.classList.add('flash'); setTimeout(() => bz.classList.remove('flash'), 700); }
  setMsg('الجولة بدأت! اضغط الآن');
});

// ─────────────────────────────────────────────────────────────
// Render
// All UI state is derived from the authoritative server snapshot,
// not from ephemeral client-side flags.  This means a player who
// returns after hours sees exactly the correct screen immediately.
// ─────────────────────────────────────────────────────────────
function render(state) {
  if (!myPlayerId) return;
  const me = state.players.find(p => p.id === myPlayerId);
  if (!me) return;

  document.getElementById('p-score').textContent = me.score;
  document.getElementById('p-round').textContent = state.round;
  document.getElementById('p-countdown').textContent =
    (state.roundLocked && !state.winnerId) ? state.countdown : '-';

  const isBlocked = (state.blockedIds || []).includes(myPlayerId);
  const iAmWinner = state.winnerId === myPlayerId;

  const bz = document.getElementById('buzzer');
  if (bz) bz.disabled = state.gameLocked || state.roundLocked || me.hasPressed || isBlocked;

  const cb = document.getElementById('countdown-badge');
  if (cb) cb.textContent =
    (!state.winnerId && state.roundLocked && !state.gameLocked && state.countdown > 0)
      ? state.countdown : '';

  // Message derived from server state (safe after any reconnect)
  if (state.gameLocked) {
    setMsg('🏁 انتهت اللعبة');
  } else if (iAmWinner) {
    setMsg('🎉 أنت الأول! انتظر قرار المدير');
  } else if (isBlocked && me.status === 'wrong') {
    setMsg('❌ إجابة خاطئة — أنت خارج هذه الجولة');
  } else if (me.hasPressed && !iAmWinner) {
    setMsg('⛔ تأخرت!');
  }

  const tb = document.getElementById('p-players-tbody');
  if (tb) tb.innerHTML = state.players.map(p => `
    <tr>
      <td style="font-weight:700">${p.name}${p.id === myPlayerId ? ' (أنت)' : ''}</td>
      <td>${p.score}</td>
      <td class="${statusClass(p.status)}">${statusLabel(p.status)}</td>
    </tr>`).join('');
}
