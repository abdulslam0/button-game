// admin.js  —  v4
// Loaded by admin.html via <script src="/admin.js">

// ── Admin session persistence ─────────────────────────────────
// Stores { roomCode, gameName } so the admin can refresh the page
// or switch tabs and return to their dashboard without re-creating
// the room.
const ADMIN_LS_KEY = 'buzzer_admin_session';

function loadAdminSession()  { try { return JSON.parse(localStorage.getItem(ADMIN_LS_KEY)); } catch { return null; } }
function saveAdminSession(s) { localStorage.setItem(ADMIN_LS_KEY, JSON.stringify(s)); }
function clearAdminSession() { localStorage.removeItem(ADMIN_LS_KEY); }

// ── Runtime state ─────────────────────────────────────────────
let roomCode   = null;
const MEDALS   = ['🥇', '🥈', '🥉'];

// ── Socket ────────────────────────────────────────────────────
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
function soundReset() { tone(440, .2); setTimeout(() => tone(550, .15), 80); }
function soundPoint() { tone(523, .15, 'sine', .4); setTimeout(() => tone(659, .2, 'sine', .4), 150); }

// ── Helpers ───────────────────────────────────────────────────
function statusLabel(s) {
  return { winner: '🏆 فائز', ready: '✅ جاهز', 'too-late': '⛔ تأخر', offline: '🔴 غائب', wrong: '❌ خطأ' }[s] || s;
}
function statusClass(s) {
  return { winner: 'status-winner', ready: 'status-ready', 'too-late': 'status-too-late', offline: 'status-offline', wrong: 'status-wrong' }[s] || '';
}

// Emit an admin action — always includes roomCode
function emit(event) { socket.emit(event, { roomCode }); }

// ─────────────────────────────────────────────────────────────
// Auto-rejoin on socket connect
// If a session is saved, attempt to re-attach to the room.
// ─────────────────────────────────────────────────────────────
socket.on('connect', () => {
  const session = loadAdminSession();
  if (session && session.roomCode && !roomCode) {
    socket.emit('admin:rejoin', { roomCode: session.roomCode });
  }
});

// ── Create room ───────────────────────────────────────────────
function createRoom() {
  const name  = document.getElementById('game-name').value.trim();
  const code  = document.getElementById('room-code').value.trim();
  const errEl = document.getElementById('setup-error');
  errEl.textContent = '';

  if (!name) { errEl.textContent = 'أدخل اسم اللعبة.'; return; }
  if (!/^\d{4}$/.test(code)) { errEl.textContent = 'الرمز يجب أن يكون 4 أرقام بالضبط.'; return; }

  socket.emit('admin:create-room', { gameName: name, roomCode: code });
}

// ─────────────────────────────────────────────────────────────
// Socket events
// ─────────────────────────────────────────────────────────────

socket.on('room:created', ({ roomCode: code, gameName }) => {
  roomCode = code;
  saveAdminSession({ roomCode: code, gameName });
  document.getElementById('a-room-code').textContent = code;
  document.getElementById('a-game-name').textContent = gameName;
  document.getElementById('view-setup').style.display = 'none';
  document.getElementById('view-admin').style.display = 'flex';
});

socket.on('room:error', (msg) => {
  // If in setup view show inline error; otherwise ignore (stale session)
  const setupEl = document.getElementById('setup-error');
  if (document.getElementById('view-setup').style.display !== 'none') {
    setupEl.textContent = msg;
  }
  // If rejoin failed (room gone), clear session and show setup form
  if (msg.includes('لا توجد غرفة نشطة')) {
    clearAdminSession();
    roomCode = null;
    document.getElementById('view-setup').style.display = 'flex';
    document.getElementById('view-admin').style.display = 'none';
    setupEl.textContent = 'انتهت الجلسة السابقة. أنشئ غرفة جديدة.';
  }
});

// Full state snapshot — sent immediately on (re)join and on
// every state mutation.  Admin sees live data the moment they load.
socket.on('game:state', render);

socket.on('round:active-flash', () => soundReset());

// ─────────────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────────────
function render(state) {
  document.getElementById('a-round').textContent     = state.round;
  document.getElementById('a-countdown').textContent = state.countdown ?? '-';
  document.getElementById('event-feed').textContent  = state.lastEvent;

  const hasWinner = !!state.winnerId;
  document.getElementById('btn-give-point').disabled = !hasWinner;
  document.getElementById('btn-unlock').disabled     = !hasWinner;

  // Play a sound when a player buzzes in
  if (hasWinner) soundPoint();

  // Players table
  const tb = document.getElementById('a-players-tbody');
  if (state.players.length === 0) {
    tb.innerHTML = '<tr><td colspan="3" style="color:#aaa;text-align:center;padding:1rem">لا يوجد لاعبون بعد</td></tr>';
  } else {
    tb.innerHTML = state.players.map(p => {
      const blocked = (state.blockedIds || []).includes(p.id);
      return `<tr>
        <td style="font-weight:700">${p.name}${blocked ? ' 🚫' : ''}</td>
        <td>${p.score}</td>
        <td class="${statusClass(p.status)}">${statusLabel(p.status)}</td>
      </tr>`;
    }).join('');
  }

  // Leaderboard
  const sorted = [...state.players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  document.getElementById('a-leaderboard').innerHTML = sorted.length
    ? sorted.map((p, i) => `
        <div class="lb-item">
          <span>${MEDALS[i] || '•'} ${p.name}</span>
          <span>${p.score}</span>
        </div>`).join('')
    : '<p style="color:#aaa;text-align:center">لا يوجد لاعبون بعد</p>';
}
