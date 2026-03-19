/**
 * server/index.js
 * ─────────────────────────────────────────────────────────────
 * Multi-room buzzer game server.
 *
 * Room store shape (rooms Map):
 * {
 *   roomCode  : "1234",
 *   gameName  : "Quiz Night",
 *   adminId   : socket.id,           // socket that created the room
 *   state: {
 *     gameLocked  : false,
 *     roundLocked : true,
 *     round       : 1,
 *     countdown   : 5,
 *     winnerId    : null,
 *     winnerName  : null,
 *     lastEvent   : "...",
 *     blockedIds  : [],              // locked out for current round
 *     answerTimer : null,
 *     players     : Map<id, player>  // NOT serialised directly
 *   }
 * }
 *
 * Socket events received  → handler
 * ─────────────────────────────────
 * admin:create-room        { gameName, roomCode }
 * player:join              { name, roomCode }
 * player:buzz              { roomCode, sentAt }
 * admin:give-point         { roomCode }
 * admin:reset-round        { roomCode }
 * admin:new-game           { roomCode }
 * admin:end-game           { roomCode }
 * admin:unlock-buzzer      { roomCode }
 *
 * Socket events emitted    → recipients
 * ─────────────────────────────────────
 * room:created             → admin socket
 * room:error               → requesting socket
 * player:self              → joining player socket
 * game:state               → all sockets in room
 * round:active-flash       → all sockets in room
 * answer:tick              → all sockets in room
 * answer:done              → all sockets in room
 */

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const { v4: uuidv4 } = require('uuid');

// ── tiny uuid shim if uuid not available ──────────────────────
function makeId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 4000;
const COUNTDOWN_SECS    = 5;
const ANSWER_TIMER_SECS = 3;

// ── Serve static files from /public ───────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Room store ────────────────────────────────────────────────
// Map<roomCode, room>
const rooms = new Map();

// ── Helpers ───────────────────────────────────────────────────
function playerView(p) {
  return { id: p.id, name: p.name, score: p.score, status: p.status, hasPressed: p.hasPressed };
}

function serialiseRoom(room) {
  const { state } = room;
  const players = [...state.players.values()].map(playerView)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return {
    gameName    : room.gameName,
    roomCode    : room.roomCode,
    gameLocked  : state.gameLocked,
    roundLocked : state.roundLocked,
    round       : state.round,
    countdown   : state.countdown,
    winnerId    : state.winnerId,
    winnerName  : state.winnerName,
    lastEvent   : state.lastEvent,
    blockedIds  : state.blockedIds,
    answerTimer : state.answerTimer,
    players,
  };
}

function broadcast(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  io.to(roomCode).emit('game:state', serialiseRoom(room));
}

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
    answerTimer : null,
    players     : new Map(),
    _cTimer     : null,   // countdown interval handle
    _aTimer     : null,   // answer timer interval handle
  };
}

// ── Round helpers (operate on a room's state) ─────────────────
function clearTimers(state) {
  clearInterval(state._cTimer);
  clearInterval(state._aTimer);
  state._cTimer = null;
  state._aTimer = null;
}

function resetRoundState(state) {
  clearTimers(state);
  state.roundLocked = true;
  state.winnerId    = null;
  state.winnerName  = null;
  state.blockedIds  = [];
  state.answerTimer = null;
  for (const p of state.players.values()) {
    p.hasPressed = false;
    p.status     = 'ready';
  }
}

function startCountdown(roomCode) {
  const room  = rooms.get(roomCode);
  if (!room) return;
  const state = room.state;

  clearInterval(state._cTimer);
  state.countdown  = COUNTDOWN_SECS;
  state.lastEvent  = `الجولة ${state.round} تبدأ خلال ${state.countdown}s`;
  broadcast(roomCode);

  state._cTimer = setInterval(() => {
    state.countdown -= 1;
    if (state.countdown <= 0) {
      clearInterval(state._cTimer);
      state._cTimer     = null;
      state.roundLocked = false;
      state.lastEvent   = `الجولة ${state.round} بدأت الآن!`;
      broadcast(roomCode);
      io.to(roomCode).emit('round:active-flash');
      return;
    }
    state.lastEvent = `الجولة ${state.round} تبدأ خلال ${state.countdown}s`;
    broadcast(roomCode);
  }, 1000);
}

function startAnswerTimer(roomCode) {
  const room  = rooms.get(roomCode);
  if (!room) return;
  const state = room.state;

  clearInterval(state._aTimer);
  state.answerTimer = ANSWER_TIMER_SECS;
  io.to(roomCode).emit('answer:tick', { secs: state.answerTimer });

  state._aTimer = setInterval(() => {
    state.answerTimer -= 1;
    if (state.answerTimer <= 0) {
      clearInterval(state._aTimer);
      state._aTimer     = null;
      state.answerTimer = null;
      io.to(roomCode).emit('answer:done');
      return;
    }
    io.to(roomCode).emit('answer:tick', { secs: state.answerTimer });
  }, 1000);
}

function stopAnswerTimer(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  clearInterval(room.state._aTimer);
  room.state._aTimer     = null;
  room.state.answerTimer = null;
  io.to(roomCode).emit('answer:done');
}

// ── Socket.io ─────────────────────────────────────────────────
io.on('connection', (socket) => {

  // ── Admin: create room ───────────────────────────────────────
  socket.on('admin:create-room', ({ gameName, roomCode }) => {
    const code = String(roomCode || '').trim();
    const name = String(gameName  || '').trim();

    if (!/^\d{4}$/.test(code)) {
      return socket.emit('room:error', 'الرمز يجب أن يكون 4 أرقام بالضبط.');
    }
    if (!name) {
      return socket.emit('room:error', 'أدخل اسم اللعبة.');
    }
    if (rooms.has(code)) {
      return socket.emit('room:error', `الرمز ${code} مستخدم بالفعل. اختر رمزاً آخر.`);
    }

    const room = {
      roomCode : code,
      gameName : name,
      adminId  : socket.id,
      state    : defaultState(),
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.isAdmin  = true;

    socket.emit('room:created', { roomCode: code, gameName: name });
    broadcast(code);
    console.log(`[room created] ${code} "${name}"`);
  });

  // ── Player: join room ────────────────────────────────────────
  socket.on('player:join', ({ name, roomCode }) => {
    const code     = String(roomCode || '').trim();
    const trimName = String(name || '').trim().slice(0, 30);

    if (!trimName) return socket.emit('room:error', 'أدخل اسمك.');
    if (!/^\d{4}$/.test(code)) return socket.emit('room:error', 'الرمز يجب أن يكون 4 أرقام.');

    const room = rooms.get(code);
    if (!room) return socket.emit('room:error', `لا توجد غرفة بالرمز ${code}.`);
    if (room.state.gameLocked) return socket.emit('room:error', 'اللعبة منتهية. انتظر جولة جديدة.');

    // Unique name check
    const nameTaken = [...room.state.players.values()]
      .some(p => p.name.toLowerCase() === trimName.toLowerCase());
    if (nameTaken) {
      return socket.emit('room:error', `الاسم "${trimName}" مستخدم في هذه الغرفة. اختر اسماً آخر.`);
    }

    const player = {
      id        : makeId(),
      name      : trimName,
      score     : 0,
      status    : 'ready',
      hasPressed: false,
    };
    room.state.players.set(player.id, player);
    socket.join(code);
    socket.data.roomCode  = code;
    socket.data.playerId  = player.id;
    socket.data.isAdmin   = false;

    socket.emit('player:self', playerView(player));
    room.state.lastEvent = `${trimName} انضم إلى اللعبة.`;
    broadcast(code);
    console.log(`[player joined] ${trimName} → room ${code}`);
  });

  // ── Player: buzz ─────────────────────────────────────────────
  socket.on('player:buzz', ({ sentAt }) => {
    const { roomCode, playerId } = socket.data;
    const room = rooms.get(roomCode);
    if (!room) return;
    const { state } = room;

    if (state.gameLocked || state.roundLocked) return;
    if (state.blockedIds.includes(playerId)) return;

    const player = state.players.get(playerId);
    if (!player || player.hasPressed) return;

    player.hasPressed = true;

    if (!state.winnerId) {
      state.winnerId    = player.id;
      state.winnerName  = player.name;
      state.roundLocked = true;
      player.status     = 'winner';
      for (const p of state.players.values()) {
        if (p.id !== player.id) p.status = 'too-late';
      }
      state.lastEvent = `${player.name} ضغط أولاً!`;
      io.to(roomCode).emit('round:winner', {
        winnerId  : player.id,
        winnerName: player.name,
        sentAt,
      });
      broadcast(roomCode);
      startAnswerTimer(roomCode);
    } else {
      broadcast(roomCode);
    }
  });

  // ── Admin: give point ────────────────────────────────────────
  socket.on('admin:give-point', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room || !room.state.winnerId) return;
    const winner = room.state.players.get(room.state.winnerId);
    if (!winner) return;
    winner.score += 1;
    room.state.lastEvent = `${winner.name} حصل على +1 نقطة.`;
    stopAnswerTimer(roomCode);
    broadcast(roomCode);
  });

  // ── Admin: reset round ───────────────────────────────────────
  socket.on('admin:reset-round', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room || room.state.gameLocked) return;
    resetRoundState(room.state);
    room.state.lastEvent = 'تم إعادة تعيين الجولة.';
    startCountdown(roomCode);
  });

  // ── Admin: new game ──────────────────────────────────────────
  socket.on('admin:new-game', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    room.state.gameLocked = false;
    room.state.round += 1;
    for (const p of room.state.players.values()) p.score = 0;
    resetRoundState(room.state);
    room.state.lastEvent = `لعبة جديدة بدأت. الجولة ${room.state.round}.`;
    startCountdown(roomCode);
  });

  // ── Admin: end game ──────────────────────────────────────────
  socket.on('admin:end-game', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    stopAnswerTimer(roomCode);
    clearTimers(room.state);
    room.state.gameLocked  = true;
    room.state.roundLocked = true;
    room.state.lastEvent   = 'انتهت اللعبة.';
    broadcast(roomCode);
  });

  // ── Admin: unlock buzzer (wrong answer) ──────────────────────
  socket.on('admin:unlock-buzzer', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room || !room.state.winnerId) return;
    const { state } = room;

    const wrongPlayer = state.players.get(state.winnerId);
    if (!wrongPlayer) return;

    stopAnswerTimer(roomCode);
    if (!state.blockedIds.includes(state.winnerId)) {
      state.blockedIds.push(state.winnerId);
    }
    wrongPlayer.status     = 'wrong';
    wrongPlayer.hasPressed = true;

    state.winnerId    = null;
    state.winnerName  = null;
    state.roundLocked = false;
    state.answerTimer = null;

    for (const p of state.players.values()) {
      if (!state.blockedIds.includes(p.id)) {
        p.hasPressed = false;
        p.status     = 'ready';
      }
    }

    state.lastEvent = `${wrongPlayer.name} أجاب خطأ — الزر مفتوح للبقية.`;
    broadcast(roomCode);
    io.to(roomCode).emit('round:active-flash');
  });

  // ── Disconnect ───────────────────────────────────────────────
  socket.on('disconnect', () => {
    const { roomCode, playerId, isAdmin } = socket.data;
    const room = rooms.get(roomCode);
    if (!room) return;

    if (isAdmin) {
      // Admin left — notify room but keep it alive
      room.state.lastEvent = 'المدير قطع الاتصال.';
      room.adminId = null;
      broadcast(roomCode);
    } else if (playerId) {
      const p = room.state.players.get(playerId);
      if (p) {
        p.status = 'offline';
        room.state.lastEvent = `${p.name} خرج من اللعبة.`;
        broadcast(roomCode);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Buzzer server running → http://localhost:${PORT}`);
  console.log(`  /         → home`);
  console.log(`  /admin    → admin page`);
  console.log(`  /play     → player page`);
});
