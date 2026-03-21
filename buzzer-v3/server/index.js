/**
 * server/index.js — v8
 * New: lobby phase, buzzerColor + logoUrl room metadata broadcast,
 * room:lobby-update event, admin:start-game event.
 * All v7 sync/fairness/volatile logic preserved intact.
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
  maxHttpBufferSize : 1e5,
});

const PORT            = process.env.PORT || 4000;
const COUNTDOWN_SECS  = 5;
const BUZZ_WINDOW_MS  = 30;
const CLOCK_DRIFT_MAX = 5000;
const rooms = new Map();

function makeId(){
  return Math.random().toString(36).slice(2,10)+Date.now().toString(36);
}

function playerView(p){
  return { id:p.id, name:p.name, score:p.score, status:p.status, hasPressed:p.hasPressed };
}

function serialiseRoom(room){
  const {state}=room;
  const players=[...state.players.values()].map(playerView)
    .sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name));
  return {
    gameName   :room.gameName,
    roomCode   :room.roomCode,
    buzzerColor:room.buzzerColor,
    logoUrl    :room.logoUrl,
    inLobby    :room.inLobby,
    gameLocked :state.gameLocked,
    roundLocked:state.roundLocked,
    round      :state.round,
    countdown  :state.countdown,
    winnerId   :state.winnerId,
    winnerName :state.winnerName,
    lastEvent  :state.lastEvent,
    blockedIds :state.blockedIds,
    players,
  };
}

function deltaState(room){
  const {state}=room;
  return {
    inLobby    :room.inLobby,
    gameLocked :state.gameLocked,
    roundLocked:state.roundLocked,
    round      :state.round,
    countdown  :state.countdown,
    winnerId   :state.winnerId,
    winnerName :state.winnerName,
    lastEvent  :state.lastEvent,
    blockedIds :state.blockedIds,
  };
}

function broadcastFull(code){
  const room=rooms.get(code);
  if(room) io.to(code).emit('game:state',serialiseRoom(room));
}
function broadcastDelta(code){
  const room=rooms.get(code);
  if(room) io.to(code).emit('game:delta',deltaState(room));
}
function broadcastTick(code){
  const room=rooms.get(code);
  if(!room) return;
  const {state}=room;
  io.to(code).volatile.emit('game:tick',{round:state.round,countdown:state.countdown,locked:state.roundLocked});
}
function unicastState(socket,code){
  const room=rooms.get(code);
  if(room) socket.emit('game:state',serialiseRoom(room));
}

function defaultState(){
  return {
    gameLocked:false, roundLocked:true, round:1,
    countdown:COUNTDOWN_SECS, winnerId:null, winnerName:null,
    lastEvent:'في انتظار بداية اللعبة من المدير.',
    blockedIds:[], players:new Map(),
    _cTimer:null, _firstPressAt:null, _buzzQueue:[], _buzzTimer:null, _lockOwner:null,
  };
}

function clearTimers(state){
  clearInterval(state._cTimer); clearTimeout(state._buzzTimer);
  state._cTimer=null; state._buzzTimer=null;
}
function resetRoundState(state){
  clearTimers(state);
  state.roundLocked=true; state.winnerId=null; state.winnerName=null;
  state.blockedIds=[]; state._firstPressAt=null; state._buzzQueue=[]; state._lockOwner=null;
  for(const p of state.players.values()){ p.hasPressed=false; p.status='ready'; }
}
function startCountdown(code){
  const room=rooms.get(code); if(!room) return;
  const {state}=room;
  clearInterval(state._cTimer);
  state.countdown=COUNTDOWN_SECS; state.roundLocked=true;
  state.lastEvent=`الجولة ${state.round} تبدأ خلال ${state.countdown}s`;
  broadcastFull(code);
  state._cTimer=setInterval(()=>{
    state.countdown-=1;
    if(state.countdown<=0){
      clearInterval(state._cTimer); state._cTimer=null;
      state.roundLocked=false;
      state.lastEvent=`الجولة ${state.round} بدأت الآن!`;
      broadcastDelta(code);
      io.to(code).volatile.emit('round:active-flash');
      return;
    }
    state.lastEvent=`الجولة ${state.round} تبدأ خلال ${state.countdown}s`;
    broadcastTick(code);
  },1000);
}

function resolveBuzzQueue(code){
  const room=rooms.get(code); if(!room) return;
  const {state}=room;
  if(!state._buzzQueue.length) return;
  const now=Date.now();
  state._buzzQueue.sort((a,b)=>{
    const aOk=a.sentAt&&Math.abs(a.sentAt-now)<CLOCK_DRIFT_MAX;
    const bOk=b.sentAt&&Math.abs(b.sentAt-now)<CLOCK_DRIFT_MAX;
    if(aOk&&bOk) return a.sentAt-b.sentAt;
    if(aOk) return -1; if(bOk) return 1; return 0;
  });
  const winner=state._buzzQueue[0];
  const winPlayer=state.players.get(winner.pid);
  if(!winPlayer) return;
  state.winnerId=winner.pid; state.winnerName=winPlayer.name; winPlayer.status='winner';
  for(let i=1;i<state._buzzQueue.length;i++){
    const p=state.players.get(state._buzzQueue[i].pid);
    if(p) p.status='too-late';
  }
  for(const p of state.players.values()){
    if(!p.hasPressed&&p.id!==winner.pid) p.status='too-late';
  }
  state.lastEvent=`${winPlayer.name} ضغط أولاً!`;
  state._buzzQueue=[];
  io.to(code).volatile.emit('round:winner',{winnerId:winner.pid,winnerName:winPlayer.name,sentAt:winner.sentAt});
  broadcastFull(code);
}

io.on('connection',(socket)=>{

  socket.on('admin:create-room',({gameName,roomCode,buzzerColor,logoUrl})=>{
    const code=String(roomCode||'').trim();
    const name=String(gameName||'').trim();
    if(!/^\d{4}$/.test(code)) return socket.emit('room:error','الرمز يجب أن يكون 4 أرقام بالضبط.');
    if(!name) return socket.emit('room:error','أدخل اسم اللعبة.');
    if(rooms.has(code)) return socket.emit('room:error',`الرمز ${code} مستخدم بالفعل.`);
    const room={
      roomCode:code, gameName:name,
      buzzerColor:buzzerColor||'#b60012',
      logoUrl:logoUrl||'',
      inLobby:true,             // NEW: start in lobby
      adminSocketId:socket.id,
      state:defaultState(),
    };
    rooms.set(code,room);
    socket.join(code);
    socket.data.roomCode=code; socket.data.isAdmin=true;
    socket.emit('room:created',{roomCode:code,gameName:name});
    broadcastFull(code);
    console.log(`[room created] ${code} "${name}"`);
  });

  socket.on('admin:rejoin',({roomCode})=>{
    const code=String(roomCode||'').trim();
    const room=rooms.get(code);
    if(!room) return socket.emit('room:error',`لا توجد غرفة ${code}.`);
    room.adminSocketId=socket.id;
    socket.data.roomCode=code; socket.data.isAdmin=true;
    socket.join(code);
    socket.emit('room:created',{roomCode:code,gameName:room.gameName});
    unicastState(socket,code);
  });

  // NEW: admin starts game from lobby
  socket.on('admin:start-game',({roomCode:rc})=>{
    const code=rc||socket.data.roomCode;
    const room=rooms.get(code);
    if(!room) return;
    room.inLobby=false;
    room.state.lastEvent='اللعبة بدأت!';
    startCountdown(code);
  });

  // NEW: admin updates brand settings live
  socket.on('admin:update-brand',({roomCode:rc,buzzerColor,logoUrl})=>{
    const code=rc||socket.data.roomCode;
    const room=rooms.get(code);
    if(!room) return;
    if(buzzerColor) room.buzzerColor=buzzerColor;
    if(logoUrl!==undefined) room.logoUrl=logoUrl;
    broadcastFull(code);
  });

  socket.on('client:resync',({persistentId,roomCode})=>{
    const code=String(roomCode||'').trim();
    const pid=String(persistentId||'').trim();
    const room=rooms.get(code);
    if(!room||!pid) return;
    const player=room.state.players.get(pid);
    if(!player) return;
    if(player.status==='offline') player.status='ready';
    socket.join(code);
    socket.data.roomCode=code; socket.data.persistentId=pid; socket.data.isAdmin=false;
    socket.emit('player:self',playerView(player));
    unicastState(socket,code);
    room.state.lastEvent=`${player.name} عاد إلى اللعبة.`;
    broadcastDelta(code);
  });

  socket.on('player:join',({name,roomCode,persistentId})=>{
    const code=String(roomCode||'').trim();
    const trimName=String(name||'').trim().slice(0,30);
    const pid=String(persistentId||'').trim();
    if(!trimName) return socket.emit('room:error','أدخل اسمك.');
    if(!/^\d{4}$/.test(code)) return socket.emit('room:error','الرمز يجب أن يكون 4 أرقام.');
    const room=rooms.get(code);
    if(!room) return socket.emit('room:error',`لا توجد غرفة بالرمز ${code}.`);
    if(room.state.gameLocked) return socket.emit('room:error','اللعبة منتهية.');

    if(pid&&room.state.players.has(pid)){
      const ex=room.state.players.get(pid);
      if(ex.status==='offline') ex.status='ready';
      socket.join(code);
      socket.data.roomCode=code; socket.data.persistentId=pid; socket.data.isAdmin=false;
      socket.emit('player:self',playerView(ex));
      unicastState(socket,code);
      room.state.lastEvent=`${ex.name} عاد.`;
      broadcastFull(code);
      return;
    }
    const nameTaken=[...room.state.players.values()].some(p=>p.name.toLowerCase()===trimName.toLowerCase());
    if(nameTaken) return socket.emit('room:error',`الاسم "${trimName}" مستخدم. اختر اسماً آخر.`);
    const newPid=pid||makeId();
    const player={id:newPid,name:trimName,score:0,status:'ready',hasPressed:false};
    room.state.players.set(newPid,player);
    socket.join(code);
    socket.data.roomCode=code; socket.data.persistentId=newPid; socket.data.isAdmin=false;
    socket.emit('player:self',playerView(player));
    room.state.lastEvent=`${trimName} انضم.`;
    broadcastFull(code);
  });

  socket.on('player:buzz',({roomCode:rc,sentAt})=>{
    const code=rc||socket.data.roomCode;
    const pid=socket.data.persistentId;
    const room=rooms.get(code);
    if(!room) return;
    const {state}=room;
    if(room.inLobby||state.gameLocked||state.roundLocked) return;
    if(state.blockedIds.includes(pid)) return;
    const player=state.players.get(pid);
    if(!player||player.hasPressed) return;
    player.hasPressed=true;
    const serverNow=Date.now();
    if(state._firstPressAt===null){
      state._firstPressAt=serverNow; state._lockOwner=pid; state.roundLocked=true;
      state._buzzQueue.push({pid,sentAt:sentAt||null});
      state._buzzTimer=setTimeout(()=>resolveBuzzQueue(code),BUZZ_WINDOW_MS);
    } else if(serverNow-state._firstPressAt<=BUZZ_WINDOW_MS){
      state._buzzQueue.push({pid,sentAt:sentAt||null});
    }
  });

  socket.on('admin:give-point',({roomCode:rc})=>{
    const code=rc||socket.data.roomCode;
    const room=rooms.get(code);
    if(!room||!room.state.winnerId) return;
    const winner=room.state.players.get(room.state.winnerId);
    if(!winner) return;
    winner.score+=1;
    const scoredName=winner.name;
    resetRoundState(room.state);
    room.state.lastEvent=`✅ ${scoredName} حصل على نقطة — الجولة التالية تبدأ!`;
    startCountdown(code);
  });

  socket.on('admin:reset-round',({roomCode:rc})=>{
    const code=rc||socket.data.roomCode;
    const room=rooms.get(code);
    if(!room||room.state.gameLocked) return;
    resetRoundState(room.state);
    room.state.lastEvent='تم إعادة تعيين الجولة يدوياً.';
    startCountdown(code);
  });

  socket.on('admin:new-game',({roomCode:rc})=>{
    const code=rc||socket.data.roomCode;
    const room=rooms.get(code);
    if(!room) return;
    room.state.gameLocked=false; room.state.round+=1;
    for(const p of room.state.players.values()) p.score=0;
    resetRoundState(room.state);
    room.state.lastEvent=`لعبة جديدة — الجولة ${room.state.round}.`;
    startCountdown(code);
  });

  socket.on('admin:end-game',({roomCode:rc})=>{
    const code=rc||socket.data.roomCode;
    const room=rooms.get(code);
    if(!room) return;
    clearTimers(room.state);
    room.state.gameLocked=true; room.state.roundLocked=true;
    room.state.lastEvent='انتهت اللعبة.';
    broadcastFull(code);
  });

  socket.on('admin:unlock-buzzer',({roomCode:rc})=>{
    const code=rc||socket.data.roomCode;
    const room=rooms.get(code);
    if(!room||!room.state.winnerId) return;
    const {state}=room;
    const wrong=state.players.get(state.winnerId);
    if(!wrong) return;
    if(!state.blockedIds.includes(state.winnerId)) state.blockedIds.push(state.winnerId);
    wrong.status='wrong'; wrong.hasPressed=true;
    state.winnerId=null; state.winnerName=null; state.roundLocked=false;
    state._lockOwner=null; state._firstPressAt=null; state._buzzQueue=[];
    clearTimeout(state._buzzTimer); state._buzzTimer=null;
    for(const p of state.players.values()){
      if(!state.blockedIds.includes(p.id)){ p.hasPressed=false; p.status='ready'; }
    }
    state.lastEvent=`${wrong.name} أجاب خطأ — الزر مفتوح للبقية.`;
    broadcastFull(code);
    io.to(code).volatile.emit('round:active-flash');
  });

  socket.on('disconnect',()=>{
    const {roomCode:code,persistentId:pid,isAdmin}=socket.data;
    const room=rooms.get(code);
    if(!room) return;
    if(isAdmin){
      room.state.lastEvent='المدير قطع الاتصال مؤقتاً.';
      broadcastDelta(code);
    } else if(pid){
      const p=room.state.players.get(pid);
      if(p){ p.status='offline'; room.state.lastEvent=`${p.name} خرج مؤقتاً.`; broadcastFull(code); }
    }
  });
});

server.listen(PORT,()=>{
  console.log(`\nBuzzer v8  →  http://localhost:${PORT}\n`);
});
