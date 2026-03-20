/**
 * server/index.js  —  v4
 * Changes: persistent player IDs, admin:rejoin, client:resync,
 * no answer timer, auto-round-reset after give-point,
 * full state unicast on every (re)connection.
 */

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors        : { origin: '*' },
  pingTimeout : 60000,
  pingInterval: 25000,
});

const PORT           = process.env.PORT || 4000;
const COUNTDOWN_SECS = 5;

app.use(express.static(path.join(__dirname, '..', 'public')));

const rooms = new Map();

// ── Helpers ───────────────────────────────────────────────────
function makeId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function playerView(p) {
  return { id: p.id, name: p.name, score: p.score, status: p.status, hasPressed: p.hasPressed };
}

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

function broadcast(code) {
  const room = rooms.get(code);
  if (room) io.to(code).emit('game:state', serialiseRoom(room));
}

function unicastState(socket, code) {
  const room = rooms.get(code);
  if (room) socket.emit('game:state', serialiseRoom(room));
}

function defaultState() {
  return {
    gameLocked : false,
    roundLocked: true,
    round      : 1,
    countdown  : COUNTDOWN_SECS,
    winnerId   : null,
    winnerName : null,
    lastEvent  : 'في انتظار بداية الجولة من المدير.',
    blockedIds : [],
    players    : new Map(),
    _cTimer    : null,
  };
}

function clearTimers(state) {
  clearInterval(state._cTimer);
  state._cTimer = null;
}

function resetRoundState(state) {
  clearTimers(state);
  state.roundLocked = true;
  state.winnerId    = null;
  state.winnerName  = null;
  state.blockedIds  = [];
  for (const p of state.players.values()) { p.hasPressed = false; p.status = 'ready'; }
}

function startCountdown(code) {
  const room = rooms.get(code);
  if (!room) return;
  const { state } = room;
  clearInterval(state._cTimer);
  state.countdown = COUNTDOWN_SECS;
  state.lastEvent = `الجولة ${state.round} تبدأ خلال ${state.countdown}s`;
  broadcast(code);

  state._cTimer = setInterval(() => {
    state.countdown -= 1;
    if (state.countdown <= 0) {
      clearInterval(state._cTimer); state._cTimer = null;
      state.roundLocked = false;
      state.lastEvent   = `الجولة ${state.round} بدأت الآن!`;
      broadcast(code);
      io.to(code).emit('round:active-flash');
      return;
    }
    state.lastEvent = `الجولة ${state.round} تبدأ خلال ${state.countdown}s`;
    broadcast(code);
  }, 1000);
}

// ── Socket.io ─────────────────────────────────────────────────
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
    broadcast(code);
    console.log(`[room created] ${code} "${name}"`);
  });

  // 2. Admin rejoin after refresh/reconnect
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

  // 3. Player resync (soft reconnect — no form needed)
  socket.on('client:resync', ({ persistentId, roomCode }) => {
    const code = String(roomCode     || '').trim();
    const pid  = String(persistentId || '').trim();
    const room = rooms.get(code);
    if (!room || !pid) return;
    const player = room.state.players.get(pid);
    if (!player) return;  // stale id — client will show join form

    if (player.status === 'offline') player.status = 'ready';
    socket.join(code);
    socket.data.roomCode     = code;
    socket.data.persistentId = pid;
    socket.data.isAdmin      = false;
    socket.emit('player:self', playerView(player));
    unicastState(socket, code);
    room.state.lastEvent = `${player.name} عاد إلى اللعبة.`;
    broadcast(code);
    console.log(`[player resynced] ${player.name} → room ${code}`);
  });

  // 4. Player join (first time)
  socket.on('player:join', ({ name, roomCode, persistentId }) => {
    const code     = String(roomCode     || '').trim();
    const trimName = String(name         || '').trim().slice(0, 30);
    const pid      = String(persistentId || '').trim();

    if (!trimName)               return socket.emit('room:error', 'أدخل اسمك.');
    if (!/^\d{4}$/.test(code))   return socket.emit('room:error', 'الرمز يجب أن يكون 4 أرقام.');
    const room = rooms.get(code);
    if (!room)                   return socket.emit('room:error', `لا توجد غرفة بالرمز ${code}.`);
    if (room.state.gameLocked)   return socket.emit('room:error', 'اللعبة منتهية.');

    // Treat as resync if persistent id already in room
    if (pid && room.state.players.has(pid)) {
      const ex = room.state.players.get(pid);
      if (ex.status === 'offline') ex.status = 'ready';
      socket.join(code);
      socket.data.roomCode = code; socket.data.persistentId = pid; socket.data.isAdmin = false;
      socket.emit('player:self', playerView(ex));
      unicastState(socket, code);
      room.state.lastEvent = `${ex.name} عاد.`;
      broadcast(code);
      return;
    }

    const nameTaken = [...room.state.players.values()]
      .some(p => p.name.toLowerCase() === trimName.toLowerCase());
    if (nameTaken) return socket.emit('room:error', `الاسم "${trimName}" مستخدم. اختر اسماً آخر.`);

    const newPid  = pid || makeId();
    const player  = { id: newPid, name: trimName, score: 0, status: 'ready', hasPressed: false };
    room.state.players.set(newPid, player);
    socket.join(code);
    socket.data.roomCode = code; socket.data.persistentId = newPid; socket.data.isAdmin = false;
    socket.emit('player:self', playerView(player));
    room.state.lastEvent = `${trimName} انضم.`;
    broadcast(code);
    console.log(`[player joined] ${trimName} → room ${code}`);
  });

  // 5. Player buzz
  socket.on('player:buzz', ({ roomCode: rc, sentAt }) => {
    const code = rc || socket.data.roomCode;
    const pid  = socket.data.persistentId;
    const room = rooms.get(code);
    if (!room) return;
    const { state } = room;
    if (state.gameLocked || state.roundLocked || state.blockedIds.includes(pid)) return;
    const player = state.players.get(pid);
    if (!player || player.hasPressed) return;
    player.hasPressed = true;
    if (!state.winnerId) {
      state.winnerId    = pid;
      state.winnerName  = player.name;
      state.roundLocked = true;
      player.status     = 'winner';
      for (const p of state.players.values()) { if (p.id !== pid) p.status = 'too-late'; }
      state.lastEvent   = `${player.name} ضغط أولاً!`;
      io.to(code).emit('round:winner', { winnerId: pid, winnerName: player.name, sentAt });
    }
    broadcast(code);
  });

  // 6. Admin give point → AUTO-RESET round
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

  // 7. Admin manual reset round
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
    broadcast(code);
  });

  // 10. Admin unlock buzzer (wrong answer)
  socket.on('admin:unlock-buzzer', ({ roomCode: rc }) => {
    const code = rc || socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || !room.state.winnerId) return;
    const { state } = room;
    const wrong = state.players.get(state.winnerId);
    if (!wrong) return;
    if (!state.blockedIds.includes(state.winnerId)) state.blockedIds.push(state.winnerId);
    wrong.status = 'wrong'; wrong.hasPressed = true;
    state.winnerId = null; state.winnerName = null; state.roundLocked = false;
    for (const p of state.players.values()) {
      if (!state.blockedIds.includes(p.id)) { p.hasPressed = false; p.status = 'ready'; }
    }
    state.lastEvent = `${wrong.name} أجاب خطأ — الزر مفتوح للبقية.`;
    broadcast(code);
    io.to(code).emit('round:active-flash');
  });

  // 11. Disconnect — keep record, just mark offline
  socket.on('disconnect', () => {
    const { roomCode: code, persistentId: pid, isAdmin } = socket.data;
    const room = rooms.get(code);
    if (!room) return;
    if (isAdmin) {
      room.state.lastEvent = 'المدير قطع الاتصال مؤقتاً.';
      broadcast(code);
    } else if (pid) {
      const p = room.state.players.get(pid);
      if (p) { p.status = 'offline'; room.state.lastEvent = `${p.name} خرج مؤقتاً.`; broadcast(code); }
    }
  });
});

server.listen(PORT, () => {
  console.log(`\nBuzzer v4  →  http://localhost:${PORT}\n`);
});