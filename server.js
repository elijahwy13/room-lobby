import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server } from 'socket.io';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Room store: code -> { players: Map, hostId, game, scores: Map, cleanupTimer? }
const rooms = new Map();
const ROOM_TTL_MS = 2 * 60 * 1000; // grace period so navigation doesn't delete room

function scheduleRoomCleanup(code) {
  const room = rooms.get(code);
  if (!room) return;
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => {
    const r = rooms.get(code);
    if (r && r.players.size === 0) rooms.delete(code);
  }, ROOM_TTL_MS);
}

function genCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 4; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

app.post('/api/rooms', (req, res) => {
  let code = genCode();
  while (rooms.has(code)) code = genCode();
  rooms.set(code, { players: new Map(), hostId: null, game: newGameState(), scores: new Map() });
  res.json({ code });
});

function newGameState() {
  return {
    phase: 'idle',            // 'idle' | 'choosing' | 'guessing' | 'revealed'
    currentTurnId: null,      // socket.id of chooser
    isAcceptingPrompt: false,
    prompt: '',
    targetValue: null,        // number (hidden until reveal)
    answerText: '',           // model’s answer text
    guesses: new Map(),       // socketId -> number
    revealed: false,
    lastWinners: []           // array of socketIds for last round (for UI)
  };
}

function roomPlayersArray(room) {
  return Array.from(room.players.values());
}

function broadcastRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  const players = roomPlayersArray(room).map(p => ({ id: p.id, name: p.name, isHost: p.id === room.hostId }));
  io.to(code).emit('room:update', { code, players });
}

function leaderboardArray(room) {
  // Convert scores map (sid->score) to [{name, score}] and sort desc
  const arr = [];
  for (const [sid, score] of room.scores.entries()) {
    const name = room.players.get(sid)?.name || '(left)';
    arr.push({ name, score });
  }
  arr.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return arr;
}

function emitGameState(code) {
  const room = rooms.get(code);
  if (!room) return;
  const players = roomPlayersArray(room).map(p => ({ id: p.id, name: p.name, isHost: p.id === room.hostId }));
  const g = room.game;
  const guessesByName = Object.fromEntries(Array.from(g.guesses.entries()).map(([sid, val]) => {
    const name = room.players.get(sid)?.name || 'Player';
    return [name, val];
  }));
  const winnerNames = g.lastWinners.map(sid => room.players.get(sid)?.name || 'Player');

  io.to(code).emit('game:state', {
    players,
    phase: g.phase,
    currentTurnId: g.currentTurnId,
    isAcceptingPrompt: g.isAcceptingPrompt,
    prompt: g.prompt,
    targetValue: g.revealed ? g.targetValue : null,
    answerText: g.revealed ? g.answerText : (g.phase === 'guessing' ? 'Answer locked. Guess now!' : ''),
    guessesByName,
    revealed: g.revealed,
    leaderboard: leaderboardArray(room),
    lastWinners: winnerNames
  });
}

function pickRandomPlayerId(room) {
  const arr = roomPlayersArray(room);
  if (arr.length === 0) return null;
  const idx = Math.floor(Math.random() * arr.length);
  return arr[idx].id;
}

// -------- Answer helpers (mock for now; plug API later) --------
async function fetchAnswerText(userPrompt) {
  // MOCK: deterministic-ish number for dev
  return `Answer: ${Math.floor(Math.random() * 50) + 1}`;
}

function extractFirstNumber(text) {
  if (!text) return null;
  const m = String(text).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}
// ---------------------------------------------------------------

io.on('connection', (socket) => {
  socket.on('room:join', ({ code, name, host = false }, ack) => {
    code = (code || '').toUpperCase();
    const room = rooms.get(code);
    if (!room) return ack?.({ ok: false, error: 'Room not found' });
    if (!name || name.trim().length === 0) return ack?.({ ok: false, error: 'Name required' });

    socket.join(code);
    socket.data.code = code;
    socket.data.name = name.trim();

    const player = { id: socket.id, name: socket.data.name };
    room.players.set(socket.id, player);
    if (room.cleanupTimer) { clearTimeout(room.cleanupTimer); room.cleanupTimer = null; }
    if (!room.hostId || host) room.hostId = socket.id;

    broadcastRoom(code);
    return ack?.({ ok: true, code, you: { id: socket.id, name: player.name, isHost: socket.id === room.hostId } });
  });

  socket.on('room:start', () => {
    const code = socket.data.code; const room = rooms.get(code);
    if (!room) return;
    if (room.hostId !== socket.id) return;
    room.game = newGameState(); // reset round state, keep scores
    io.to(code).emit('room:started');
  });

  socket.on('game:sync', () => {
    const code = socket.data.code; if (!code) return;
    emitGameState(code);
  });

  // Host starts a round: pick random chooser
  socket.on('game:startRound', () => {
    const code = socket.data.code; const room = rooms.get(code);
    if (!room) return;
    if (room.hostId !== socket.id) return;
    const g = room.game;
    g.phase = 'choosing';
    g.currentTurnId = pickRandomPlayerId(room);
    g.isAcceptingPrompt = !!g.currentTurnId;
    g.prompt = '';
    g.targetValue = null;
    g.answerText = '';
    g.guesses.clear();
    g.revealed = false;
    g.lastWinners = [];
    emitGameState(code);
  });

  // Host: next turn (fresh chooser)
  socket.on('game:nextTurn', () => {
    const code = socket.data.code; const room = rooms.get(code);
    if (!room) return;
    if (room.hostId !== socket.id) return;
    const g = room.game;
    g.phase = 'choosing';
    g.currentTurnId = pickRandomPlayerId(room);
    g.isAcceptingPrompt = !!g.currentTurnId;
    g.prompt = '';
    g.targetValue = null;
    g.answerText = '';
    g.guesses.clear();
    g.revealed = false;
    g.lastWinners = [];
    emitGameState(code);
  });

  // Chooser submits prompt -> server gets answer -> guessing phase
  socket.on('game:setPrompt', async (text, ack) => {
    const code = socket.data.code; const room = rooms.get(code);
    if (!room) return ack?.(false, 'Room missing');

    const g = room.game;
    if (!g.isAcceptingPrompt || g.currentTurnId !== socket.id) return ack?.(false, 'Not your turn');

    const prompt = String(text || '').trim().slice(0, 300);
    if (!prompt) return ack?.(false, 'Prompt is empty');

    g.prompt = prompt;
    g.isAcceptingPrompt = false;

    try {
      const answerText = await fetchAnswerText(prompt);
      const num = extractFirstNumber(answerText);
      if (num == null) {
        g.phase = 'choosing';
        g.answerText = answerText || 'No numeric answer found.';
        emitGameState(code);
        return ack?.(false, 'Could not find a numeric value in the answer.');
      }
      g.targetValue = num;
      g.answerText = answerText;
      g.phase = 'guessing'; // open guesses
      g.guesses.clear();
      g.revealed = false;
      emitGameState(code);
      return ack?.(true);
    } catch (e) {
      g.phase = 'choosing';
      emitGameState(code);
      return ack?.(false, 'Error fetching answer.');
    }
  });

  // Players submit numeric guess
  socket.on('game:guess', (value, ack) => {
    const code = socket.data.code; const room = rooms.get(code);
    if (!room) return ack?.(false, 'Room missing');
    const g = room.game;
    if (g.phase !== 'guessing') return ack?.(false, 'Not accepting guesses');
    const v = Number(value);
    if (!Number.isFinite(v)) return ack?.(false, 'Guess must be a number');
    g.guesses.set(socket.id, v);
    emitGameState(code);
    return ack?.(true);
  });

  // Host reveals → compute closest → award points → show leaderboard
  socket.on('game:revealAndScore', () => {
    const code = socket.data.code; const room = rooms.get(code);
    if (!room) return;
    if (room.hostId !== socket.id) return;
    const g = room.game;
    if (g.phase !== 'guessing') return;

    // No guesses? just reveal
    if (g.guesses.size === 0) {
      g.phase = 'revealed';
      g.revealed = true;
      g.lastWinners = [];
      emitGameState(code);
      return;
    }

    // Compute closest by absolute error
    const diffs = [];
    for (const [sid, guess] of g.guesses.entries()) {
      diffs.push({ sid, err: Math.abs(guess - g.targetValue) });
    }
    const minErr = Math.min(...diffs.map(d => d.err));
    const winners = diffs.filter(d => d.err === minErr).map(d => d.sid); // ties allowed

    // Award 1 point to each closest guesser
    for (const sid of winners) {
      const prev = room.scores.get(sid) || 0;
      room.scores.set(sid, prev + 1);
    }

    g.phase = 'revealed';
    g.revealed = true;
    g.lastWinners = winners;

    emitGameState(code);
  });

  socket.on('disconnect', () => {
    const code = socket.data.code; if (!code) return;
    const room = rooms.get(code); if (!room) return;

    room.players.delete(socket.id);

    if (room.hostId === socket.id) {
      const next = room.players.keys().next();
      room.hostId = next.done ? null : next.value;
    }

    const g = room.game;
    if (g && g.currentTurnId === socket.id) {
      g.currentTurnId = null;
      g.isAcceptingPrompt = false;
    }

    if (room.players.size === 0) {
      scheduleRoomCleanup(code);
    } else {
      broadcastRoom(code);
      emitGameState(code);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Lobby server running on http://localhost:${PORT}`));
