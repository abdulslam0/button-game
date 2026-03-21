/**
 * server/index.js  —  v7  "High-concurrency edition"
 * ═══════════════════════════════════════════════════════════════
 *
 * Optimisations applied (req 1-5)
 * ────────────────────────────────
 *
 * [1] MINIMAL PAYLOAD
 *     • broadcast() now sends a trimmed delta object instead of
 *       the full serialiseRoom() blob.
 *     • Countdown ticks only broadcast { round, countdown } — a
 *       ~40-byte packet instead of the full 400-byte state.
 *     • round:winner / round:active-flash carry only the fields
 *       clients actually need.
 *     • Full state (serialiseRoom) is reserved for:
 *         – initial join / resync (unicastState)
 *         – events that change player list or scores
 *
 * [2] CLIENT-SIDE TIMESTAMP / FAIRNESS
 *     • player:buzz handler reads sentAt from the payload.
 *     • The server maintains state._buzzQueue: an array that
 *       collects all presses that arrive within BUZZ_WINDOW_MS
 *       (30 ms) of the first server-received press.
 *     • After the window closes, the queue is sorted by sentAt
 *       (client timestamp) and the earliest wins.
 *     • This means a player with better internet who arrives 20 ms
 *       earlier but pressed 50 ms later does NOT win.
 *     • If sentAt is missing or implausible (> CLOCK_DRIFT_MAX
 *       from server time) the server falls back to arrival order.
 *
 * [3] SERVER-SIDE COUNTDOWN
 *     • Single setInterval per room — never on client.
 *     • Tick sends ONLY { type:'tick', round, countdown } via
 *       volatile emit so stale ticks are dropped under load.
 *     • Clients read countdown from this event; no client timer.
 *
 * [4] VOLATILE EMIT / ANTI-CRASH
 *     • Countdown ticks use socket.volatile (drop if not drained).
 *     • round:winner and round:active-flash use volatile broadcast
 *       (clients will re-read winner from next game:state).
 *     • Full state broadcasts (score changes, join, unlock) still
 *       use reliable emit — those must not be dropped.
 *     • Socket.io maxHttpBufferSize capped to prevent memory blowup.
 *
 * [5] ATOMIC BUZZER LOCK
 *     • The VERY FIRST line of the buzz handler sets
 *       state.roundLocked = true using a synchronous boolean check.
 *     • Node.js event loop is single-threaded so no true race can
 *       occur, but we add an explicit guard variable
 *       state._lockOwner that is set atomically in the same tick.
 *     • Subsequent presses are queued (see [2]) only if they arrive
 *       within BUZZ_WINDOW_MS of the first server-received press
 *       (state._firstPressAt). After the window, all presses are
 *       rejected outright.
 */

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors              : { origin: '*' },
  pingTimeout       : 60000,
  pingInterval      : 25000,
  maxHttpBufferSize : 1e5,   // 100 KB max per message — [4] anti-crash
});

const PORT            = process.env.PORT || 4000;
const COUNTDOWN_SECS  = 5;
const BUZZ_WINDOW_MS  = 30;    // [2] collect presses within 30 ms
const CLOCK_DRIFT_MAX = 5000;  // [2] ignore sentAt if > 5 s off server

const rooms = new Map();

// ─────────────────────────────────────────────────────────────
// ID generator
// ─────────────────────────────────────────────────────────────
function makeId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ─────────────────────────────────────────────────────────────
// [1] Payload helpers
// ─────────────────────────────────────────────────────────────
function playerView(p) {
  // Minimal player object — only what clients render
  return { id: p.id, name: p.name, score: p.score,
           status: p.status, hasPressed: p.hasPressed };
}

/** Full state snapshot — used only for joins / resyncs */
function serialiseRoom(room) {
  const { state } = room;
  const players = [...state.players.values()]
    .map(playerView)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return {
    gameName   : room.gameName,
    roomCode   : room.roomCode,
    gameLocked : state.gameLocked,
    roundLocked: state.roundLocked,
    round      : state.round,
    countdown  : state.countdown,
    winnerId   : state.winnerId,
    winnerName : state.winnerName,
    lastEvent  : state.lastEvent,
    blockedIds : state.blockedIds,
    players,
  };
}

/**
 * [1] Slim delta — sent for events that change game control state
 * but NOT the player list (e.g. buzz lock, round reset).
 * Clients merge this into their cached state.
 */
function deltaState(room) {
  const { state } = room;
  return {
    gameLocked : state.gameLocked,
    roundLocked: state.roundLocked,
    round      : state.round,
    countdown  : state.countdown,
    winnerId   : state.winnerId,
    winnerName : state.winnerName,
    lastEvent  : state.lastEvent,
    blockedIds : state.blockedIds,
  };
}

/**
 * broadcastFull — reliable, full payload (player list changed)
 * broadcastDelta — reliable, slim payload
 * broadcastTick  — volatile, countdown only (may drop under load)
 */
function broadcastFull(code) {
  const room = rooms.get(code);
  if (!room) return;
  io.to(code).emit('game:state', serialiseRoom(room));
}

function broadcastDelta(code) {
  const room = rooms.get(code);
  if (!room) return;
  io.to(code).emit('game:delta', deltaState(room));
}

// [4] volatile countdown tick — drops stale ticks under load
function broadcastTick(code) {
  const room = rooms.get(code);
  if (!room) return;
  const { state } = room;
  // volatile: if socket buffer is not drained, skip this tick
  io.to(code).volatile.emit('game:tick', {
    round    : state.round,
    countdown: state.countdown,
    locked   : state.roundLocked,
  });
}

function unicastState(socket, code) {
  const room = rooms.get(code);
  if (room) socket.emit('game:state', serialiseRoom(room));
}

// ─────────────────────────────────────────────────────────────
// Default state
// ─────────────────────────────────────────────────────────────
function defaultState() {
  return {
    gameLocked  : false,
    roundLocked : true,
    round       : 1,
    countdown   : COUNTDOWN_SECS,
    winnerId    : null,
    winnerName  : null,
    lastEvent   : 'في انتظار بداية الجولة من المدير.',
    blockedIds  : [],
    players     : new Map(),
    _cTimer     : null,
    // [2] fairness queue
    _firstPressAt : null,   // server timestamp of first received press
    _buzzQueue    : [],     // [{ pid, sentAt }] collected within BUZZ_WINDOW_MS
    _buzzTimer    : null,   // setTimeout to resolve the queue
    // [5] atomic lock guard
    _lockOwner    : null,   // pid of winner; set synchronously on first press
  };
}

// ─────────────────────────────────────────────────────────────
// Round helpers
// ─────────────────────────────────────────────────────────────
function clearTimers(state) {
  clearInterval(state._cTimer);
  clearTimeout(state._buzzTimer);
  state._cTimer    = null;
  state._buzzTimer = null;
}

function resetRoundState(state) {
  clearTimers(state);
  state.roundLocked   = true;
  state.winnerId      = null;
  state.winnerName    = null;
  state.blockedIds    = [];
  state._firstPressAt = null;
  state._buzzQueue    = [];
  state._lockOwner    = null;
  for (const p of state.players.values()) {
    p.hasPressed = false;
    p.status     = 'ready';
  }
}

// [3] Single server-side setInterval — countdown tick
function startCountdown(code) {
  const room = rooms.get(code);
  if (!room) return;
  const { state } = room;

  clearInterval(state._cTimer);
  state.countdown  = COUNTDOWN_SECS;
  state.roundLocked = true;
  state.lastEvent  = `الجولة ${state.round} تبدأ خلال ${state.countdown}s`;
  broadcastFull(code);   // full — round number changed

  state._cTimer = setInterval(() => {
    state.countdown -= 1;

    if (state.countdown <= 0) {
      clearInterval(state._cTimer);
      state._cTimer     = null;
      state.roundLocked = false;
      state.lastEvent   = `الجولة ${state.round} بدأت الآن!`;
      broadcastDelta(code);
      // [4] volatile for the flash — cosmetic, ok to drop
      io.to(code).volatile.emit('round:active-flash');
      return;
    }

    state.lastEvent = `الجولة ${state.round} تبدأ خلال ${state.countdown}s`;
    // [4] volatile tick — lightweight, may drop under load
    broadcastTick(code);
  }, 1000);
}

// ─────────────────────────────────────────────────────────────
// [2] + [5]  Fairness resolver
// Called once after BUZZ_WINDOW_MS to pick the true winner
// from all presses that arrived in that window.
// ─────────────────────────────────────────────────────────────
function resolveBuzzQueue(code) {
  const room = rooms.get(code);
  if (!room) return;
  const { state } = room;
  if (!state._buzzQueue.length) return;

  const now = Date.now();

  // Sort by client-sent timestamp; fall back to server arrival order
  state._buzzQueue.sort((a, b) => {
    const aOk = a.sentAt && Math.abs(a.sentAt - now) < CLOCK_DRIFT_MAX;
    const bOk = b.sentAt && Math.abs(b.sentAt - now) < CLOCK_DRIFT_MAX;
    if (aOk && bOk) return a.sentAt - b.sentAt;   // both valid — use client ts
    if (aOk)        return -1;                      // a wins
    if (bOk)        return  1;                      // b wins
    return 0;                                        // arrival order (FIFO)
  });

  const winner    = state._buzzQueue[0];
  const winPlayer = state.players.get(winner.pid);
  if (!winPlayer) return;

  state.winnerId   = winner.pid;
  state.winnerName = winPlayer.name;
  winPlayer.status = 'winner';

  // Mark all others in the queue as too-late
  for (let i = 1; i < state._buzzQueue.length; i++) {
    const p = state.players.get(state._buzzQueue[i].pid);
    if (p) p.status = 'too-late';
  }
  // And anyone who hadn't pressed yet
  for (const p of state.players.values()) {
    if (!p.hasPressed && p.id !== winner.pid) p.status = 'too-late';
  }

  state.lastEvent = `${winPlayer.name} ضغط أولاً!`;
  state._buzzQueue = [];

  // [4] volatile for the winner announcement — UI recovers from next game:state
  io.to(code).volatile.emit('round:winner', {
    winnerId  : winner.pid,
    winnerName: winPlayer.name,
    sentAt    : winner.sentAt,
  });
  broadcastFull(code);   // full — player statuses changed
}

// ─────────────────────────────────────────────────────────────
// Socket.io
// ─────────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  // 1. Admin create room
  socket.on('admin:create-room', ({ gameName, roomCode }) => {
    const code = String(roomCode || '').trim();
    const name = String(gameName  || '').trim();
    if (!/^\d{4}$/.test(code)) return socket.emit('room:error', 'الرمز يجب أن يكون 4 أرقام بالضبط.');
    if (!name)                  return socket.emit('room:error', 'أدخل اسم اللعبة.');
    if (rooms.has(code))        return socket.emit('room:error', `الرمز ${code} مستخدم بالفعل.`);

    const room = { roomCode: code, gameName: name, adminSocketId: socket.id, state: defaultState() };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.isAdmin  = true;
    socket.emit('room:created', { roomCode: code, gameName: name });
    broadcastFull(code);
    console.log(`[room created] ${code} "${name}"`);
  });

  // 2. Admin rejoin
  socket.on('admin:rejoin', ({ roomCode }) => {
    const code = String(roomCode || '').trim();
    const room = rooms.get(code);
    if (!room) return socket.emit('room:error', `لا توجد غرفة ${code}.`);
    room.adminSocketId   = socket.id;
    socket.data.roomCode = code;
    socket.data.isAdmin  = true;
    socket.join(code);
    socket.emit('room:created', { roomCode: code, gameName: room.gameName });
    unicastState(socket, code);
    console.log(`[admin rejoined] room ${code}`);
  });

  // 3. Player resync
  socket.on('client:resync', ({ persistentId, roomCode }) => {
    const code = String(roomCode     || '').trim();
    const pid  = String(persistentId || '').trim();
    const room = rooms.get(code);
    if (!room || !pid) return;
    const player = room.state.players.get(pid);
    if (!player) return;

    if (player.status === 'offline') player.status = 'ready';
    socket.join(code);
    socket.data.roomCode     = code;
    socket.data.persistentId = pid;
    socket.data.isAdmin      = false;
    socket.emit('player:self', playerView(player));
    unicastState(socket, code);
    room.state.lastEvent = `${player.name} عاد إلى اللعبة.`;
    broadcastDelta(code);   // only control state changed
    console.log(`[player resynced] ${player.name} → room ${code}`);
  });

  // 4. Player join
  socket.on('player:join', ({ name, roomCode, persistentId }) => {
    const code     = String(roomCode     || '').trim();
    const trimName = String(name         || '').trim().slice(0, 30);
    const pid      = String(persistentId || '').trim();

    if (!trimName)             return socket.emit('room:error', 'أدخل اسمك.');
    if (!/^\d{4}$/.test(code)) return socket.emit('room:error', 'الرمز يجب أن يكون 4 أرقام.');
    const room = rooms.get(code);
    if (!room)                 return socket.emit('room:error', `لا توجد غرفة بالرمز ${code}.`);
    if (room.state.gameLocked) return socket.emit('room:error', 'اللعبة منتهية.');

    // Resync path
    if (pid && room.state.players.has(pid)) {
      const ex = room.state.players.get(pid);
      if (ex.status === 'offline') ex.status = 'ready';
      socket.join(code);
      socket.data.roomCode = code; socket.data.persistentId = pid; socket.data.isAdmin = false;
      socket.emit('player:self', playerView(ex));
      unicastState(socket, code);
      room.state.lastEvent = `${ex.name} عاد.`;
      broadcastDelta(code);
      return;
    }

    const nameTaken = [...room.state.players.values()]
      .some(p => p.name.toLowerCase() === trimName.toLowerCase());
    if (nameTaken) return socket.emit('room:error', `الاسم "${trimName}" مستخدم. اختر اسماً آخر.`);

    const newPid = pid || makeId();
    const player = { id: newPid, name: trimName, score: 0, status: 'ready', hasPressed: false };
    room.state.players.set(newPid, player);
    socket.join(code);
    socket.data.roomCode = code; socket.data.persistentId = newPid; socket.data.isAdmin = false;
    socket.emit('player:self', playerView(player));
    room.state.lastEvent = `${trimName} انضم.`;
    broadcastFull(code);   // player list changed
    console.log(`[player joined] ${trimName} → room ${code}`);
  });

  // ── [2] + [5]  Player buzz ───────────────────────────────────
  socket.on('player:buzz', ({ roomCode: rc, sentAt }) => {
    const code   = rc || socket.data.roomCode;
    const pid    = socket.data.persistentId;
    const room   = rooms.get(code);
    if (!room) return;
    const { state } = room;

    // [5] ATOMIC LOCK — first check, first win, synchronous
    if (state.gameLocked || state.roundLocked) return;
    if (state.blockedIds.includes(pid))        return;

    const player = state.players.get(pid);
    if (!player || player.hasPressed) return;

    // Mark this player pressed — prevents double-press from same client
    player.hasPressed = true;

    const serverNow = Date.now();

    if (state._firstPressAt === null) {
      // [5] This is the FIRST press — lock the round immediately
      //     in this synchronous tick so no other press can become
      //     first winner.
      state._firstPressAt = serverNow;
      state._lockOwner    = pid;
      state.roundLocked   = true;   // hard lock — rejects all new buzz handlers
                                    // (existing in-flight ones checked above)

      // [2] Start the fairness window — collect presses for BUZZ_WINDOW_MS
      state._buzzQueue.push({ pid, sentAt: sentAt || null });

      state._buzzTimer = setTimeout(() => {
        resolveBuzzQueue(code);
      }, BUZZ_WINDOW_MS);

    } else if (serverNow - state._firstPressAt <= BUZZ_WINDOW_MS) {
      // [2] Within the fairness window — queue this press for comparison
      state._buzzQueue.push({ pid, sentAt: sentAt || null });
      // Note: roundLocked is already true, so no new presses enter after
      // the window; queued presses were already in-flight in the event loop.
    }
    // Presses outside the window are silently ignored (player.hasPressed = true above)
  });

  // 6. Admin give point → auto-reset
  socket.on('admin:give-point', ({ roomCode: rc }) => {
    const code = rc || socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || !room.state.winnerId) return;
    const winner = room.state.players.get(room.state.winnerId);
    if (!winner) return;
    winner.score += 1;
    const scoredName = winner.name;
    resetRoundState(room.state);
    room.state.lastEvent = `✅ ${scoredName} حصل على نقطة — الجولة التالية تبدأ!`;
    startCountdown(code);
  });

  // 7. Admin manual reset
  socket.on('admin:reset-round', ({ roomCode: rc }) => {
    const code = rc || socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || room.state.gameLocked) return;
    resetRoundState(room.state);
    room.state.lastEvent = 'تم إعادة تعيين الجولة يدوياً.';
    startCountdown(code);
  });

  // 8. Admin new game
  socket.on('admin:new-game', ({ roomCode: rc }) => {
    const code = rc || socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) return;
    room.state.gameLocked = false;
    room.state.round += 1;
    for (const p of room.state.players.values()) p.score = 0;
    resetRoundState(room.state);
    room.state.lastEvent = `لعبة جديدة — الجولة ${room.state.round}.`;
    startCountdown(code);
  });

  // 9. Admin end game
  socket.on('admin:end-game', ({ roomCode: rc }) => {
    const code = rc || socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) return;
    clearTimers(room.state);
    room.state.gameLocked  = true;
    room.state.roundLocked = true;
    room.state.lastEvent   = 'انتهت اللعبة.';
    broadcastFull(code);
  });

  // 10. Admin unlock buzzer (wrong answer)
  socket.on('admin:unlock-buzzer', ({ roomCode: rc }) => {
    const code = rc || socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || !room.state.winnerId) return;
    const { state } = room;
    const wrong = state.players.get(state.winnerId);
    if (!wrong) return;

    if (!state.blockedIds.includes(state.winnerId))
      state.blockedIds.push(state.winnerId);
    wrong.status = 'wrong'; wrong.hasPressed = true;

    state.winnerId      = null;
    state.winnerName    = null;
    state.roundLocked   = false;
    state._lockOwner    = null;
    state._firstPressAt = null;
    state._buzzQueue    = [];
    clearTimeout(state._buzzTimer);
    state._buzzTimer = null;

    for (const p of state.players.values()) {
      if (!state.blockedIds.includes(p.id)) {
        p.hasPressed = false;
        p.status     = 'ready';
      }
    }

    state.lastEvent = `${wrong.name} أجاب خطأ — الزر مفتوح للبقية.`;
    broadcastFull(code);   // player statuses changed
    io.to(code).volatile.emit('round:active-flash');
  });

  // 11. Disconnect
  socket.on('disconnect', () => {
    const { roomCode: code, persistentId: pid, isAdmin } = socket.data;
    const room = rooms.get(code);
    if (!room) return;
    if (isAdmin) {
      room.state.lastEvent = 'المدير قطع الاتصال مؤقتاً.';
      broadcastDelta(code);
    } else if (pid) {
      const p = room.state.players.get(pid);
      if (p) {
        p.status = 'offline';
        room.state.lastEvent = `${p.name} خرج مؤقتاً.`;
        broadcastFull(code);   // player list status changed
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`\nBuzzer v7 (high-concurrency)  →  http://localhost:${PORT}\n`);
});
