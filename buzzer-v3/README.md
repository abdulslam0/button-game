# من يضغط الزر أولاً — v3 (Multi-Room)

Real-time buzzer game with dynamic room management.

## Stack
- **Backend**: Node.js · Express · Socket.io
- **Frontend**: Vanilla HTML/CSS/JS (no build step)

## Project Structure
```
buzzer-game-v3/
├── package.json
├── server/
│   └── index.js          ← Express + Socket.io server
└── public/
    ├── index.html         ← landing page
    ├── admin.html         ← /admin route
    ├── play.html          ← /play route
    └── shared.css         ← shared styles
```

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start the server
npm start
# or for auto-reload:
npx nodemon server/index.js
```

Open:
- `http://localhost:4000/` — landing page
- `http://localhost:4000/admin.html` — admin
- `http://localhost:4000/play.html` — player

## How to Run a Game

1. **Admin** opens `/admin.html`, enters a Game Name and a 4-digit Room Code, clicks **إنشاء الغرفة**.
2. **Players** open `/play.html`, enter their name and the same 4-digit code, click **دخول**.
3. Admin controls the round from the dashboard.

## Room Isolation
Each room is a separate Socket.io room (`socket.join(roomCode)`).  
Events emitted with `io.to(roomCode).emit(...)` are scoped strictly to that room.  
Multiple simultaneous games on different codes do not interfere with each other.

## Admin Controls
| Button | Action |
|---|---|
| 1️⃣ إعطاء نقطة | Award +1 to current winner |
| 2️⃣ إعادة تعيين الجولة | Reset round (clears blocked list), start 5s countdown |
| 3️⃣ لعبة جديدة | Reset scores, increment round, start 5s countdown |
| 4️⃣ إنهاء اللعبة | Lock game |
| 🔓 فتح الزر للبقية | Mark current buzzer as wrong, add to blocked list, re-open for others |

## Socket Events Reference

### Client → Server
| Event | Payload |
|---|---|
| `admin:create-room` | `{ gameName, roomCode }` |
| `player:join` | `{ name, roomCode }` |
| `player:buzz` | `{ roomCode, sentAt }` |
| `admin:give-point` | `{ roomCode }` |
| `admin:reset-round` | `{ roomCode }` |
| `admin:new-game` | `{ roomCode }` |
| `admin:end-game` | `{ roomCode }` |
| `admin:unlock-buzzer` | `{ roomCode }` |

### Server → Client
| Event | Recipients | Payload |
|---|---|---|
| `room:created` | admin socket | `{ roomCode, gameName }` |
| `room:error` | requesting socket | `string` |
| `player:self` | joining socket | player object |
| `game:state` | all in room | full state snapshot |
| `round:winner` | all in room | `{ winnerId, winnerName, sentAt }` |
| `round:active-flash` | all in room | — |
| `answer:tick` | all in room | `{ secs }` |
| `answer:done` | all in room | — |

## Deployment

**Railway / Render / Fly.io** (recommended):
```bash
# Set PORT env var, push repo, done.
```

**Environment Variables**
| Var | Default | Description |
|---|---|---|
| `PORT` | `4000` | Server port |
