// play.js — v8 (Optimized for 30+ Players & Fairness)

// ── Persistent identity ───────────────────────────────────────
const LS_KEY = 'buzzer_player_session';
function loadSession()  { try { return JSON.parse(localStorage.getItem(LS_KEY)); } catch { return null; } }
function saveSession(s) { localStorage.setItem(LS_KEY, JSON.stringify(s)); }
function clearSession() { localStorage.removeItem(LS_KEY); }

const PERSISTENT_ID = (() => {
  const s = loadSession();
  if (s && s.id) return s.id;
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  saveSession({ id });
  return id;
})();

// ── Runtime state ─────────────────────────────────────────────
let myPlayerId = null;
let roomCode   = null;
let myName     = null;
let joined     = false;
let currentGameState = null; // مخزن الحالة للتعامل مع الـ Delta

const socket = io({
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
});

// ── Sounds & Haptics ──────────────────────────────────────────
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

function soundPress()  { 
    tone(320, .12, 'square', .4); 
    if (navigator.vibrate) navigator.vibrate(50); // اهتزاز الجوال عند الضغط
}
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

// ── Socket Connection ─────────────────────────────────────────
socket.on('connect', () => {
  const session = loadSession();
  if (session && session.id && session.roomCode && session.name) {
    myName = session.name;
    roomCode = session.roomCode;
    socket.emit('player:join', { name: myName, roomCode, persistentId: PERSISTENT_ID });
  }
});

function joinGame() {
  const name = document.getElementById('player-name').value.trim().slice(0, 30);
  const code = document.getElementById('join-code').value.trim();
  const errEl = document.getElementById('join-error');
  if (!name || !/^\d{4}$/.test(code)) { errEl.textContent = 'أدخل اسمك ورمز صحيح (4 أرقام)'; return; }

  saveSession({ id: PERSISTENT_ID, name, roomCode: code });
  socket.emit('player:join', { name, roomCode: code, persistentId: PERSISTENT_ID });
}

function buzz() {
  soundPress();
  socket.emit('player:buzz', { roomCode, sentAt: Date.now() }); // إرسال توقيت العميل للعدالة
}

// ── Socket Events (The V8 Sync Logic) ─────────────────────────

socket.on('player:self', (player) => {
  myPlayerId = player.id;
  joined = true;
  document.getElementById('p-name').textContent = player.name;
  document.getElementById('view-join').style.display = 'none';
  document.getElementById('view-play').style.display = 'flex';
});

// استلام الحالة الكاملة (Snapshot)
socket.on('game:state', (state) => {
  currentGameState = state;
  if (state.roomCode) {
      roomCode = state.roomCode;
      document.getElementById('p-room-code').textContent = roomCode;
  }
  render(state);
});

// استلام التحديثات الجزئية (Delta) - مهم جداً لسرعة الـ 30 لاعب
socket.on('game:delta', (delta) => {
  if (currentGameState) {
    Object.assign(currentGameState, delta);
    render(currentGameState);
  }
});

// استلام نبضات العداد فقط (Tick) - لتوفير البيانات واللاغ
socket.on('game:tick', (data) => {
  if (currentGameState) {
      currentGameState.countdown = data.countdown;
      currentGameState.roundLocked = data.locked;
  }
  const cdEl = document.getElementById('p-countdown');
  const badgeEl = document.getElementById('countdown-badge');
  if (cdEl) cdEl.textContent = data.countdown || '-';
  if (badgeEl) badgeEl.textContent = (data.countdown > 0) ? data.countdown : '';
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
  if (bz) { 
      bz.classList.add('flash'); 
      setTimeout(() => bz.classList.remove('flash'), 700); 
  }
  setMsg('الجولة بدأت! اضغط الآن');
});

socket.on('room:error', (msg) => {
  if (msg.includes('لا توجد غرفة')) clearSession();
  setMsg('⚠️ ' + msg);
});

// ── Render Function ──────────────────────────────────────────
function render(state) {
  if (!myPlayerId || !state.players) return;
  const me = state.players.find(p => p.id === myPlayerId || p.persistentId === PERSISTENT_ID);
  if (!me) return;

  document.getElementById('p-score').textContent = me.score || 0;
  document.getElementById('p-round').textContent = state.round || 1;
  
  // تحديث حالة الزر (Buzzer)
  const isBlocked = (state.blockedIds || []).includes(myPlayerId);
  const bz = document.getElementById('buzzer');
  if (bz) {
      bz.disabled = state.gameLocked || state.roundLocked || me.hasPressed || isBlocked;
  }

  // الرسائل التنبيهية
  if (state.gameLocked) {
    setMsg('🏁 انتهت اللعبة');
  } else if (state.winnerId === myPlayerId) {
    setMsg('🎉 أنت الأول! انتظر قرار المدير');
  } else if (isBlocked && me.status === 'wrong') {
    setMsg('❌ إجابة خاطئة — أنت خارج هذه الجولة');
  } else if (me.hasPressed && state.winnerId && state.winnerId !== myPlayerId) {
    setMsg('⛔ تأخرت!');
  }

  // تحديث قائمة اللاعبين
  const tb = document.getElementById('p-players-tbody');
  if (tb) {
    tb.innerHTML = state.players.map(p => `
      <tr>
        <td style="font-weight:700">${p.name}${p.id === myPlayerId ? ' (أنت)' : ''}</td>
        <td>${p.score}</td>
        <td class="${statusClass(p.status)}">${statusLabel(p.status)}</td>
      </tr>`).join('');
  }
}