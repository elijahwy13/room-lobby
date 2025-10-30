// server.js
import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server } from 'socket.io';

// -------------------- App & Socket setup --------------------
const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'], // robust behind proxies
  path: '/socket.io',
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ---- Daily leaderboard (in-memory seed) ----
const leaderboard = new Map([
  ['Isaac',  { wins: 4, money:  6.50 }],
  ['Elijah', { wins: 2, money: -6.20 }],
  ['Sais',   { wins: 2, money:  3.60 }],
  ['Chris',  { wins: 1, money: -6.80 }],
]);

app.get('/api/standings', (_req, res) => {
  const standings = Array.from(leaderboard.entries()).map(([name, s]) => ({
    name,
    wins: s.wins,
    money: s.money,
  }));
  res.json({ standings });
});


// Simple health check
app.get('/health', (_req, res) => res.status(200).send('ok'));

// -------------------- Room store --------------------
// code -> { players: Map(socketId -> {id, name}), hostId, game, scores: Map(socketId -> points), cleanupTimer? }
const rooms = new Map();
const ROOM_TTL_MS = 2 * 60 * 1000; // don't delete rooms immediately when everyone navigates

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

app.post('/api/rooms', (_req, res) => {
  let code = genCode();
  while (rooms.has(code)) code = genCode();
  rooms.set(code, { players: new Map(), hostId: null, game: newGameState(), scores: new Map() });
  res.json({ code });
});

// -------------------- Game state helpers --------------------
function newGameState() {
  return {
    phase: 'idle',          // 'idle' | 'choosing' | 'guessing' | 'revealed'
    currentTurnId: null,    // socket.id of chooser
    isAcceptingPrompt: false,
    prompt: '',
    targetValue: null,      // number (hidden until reveal)
    answerText: '',         // model’s short sentence
    guesses: new Map(),     // socketId -> number
    revealed: false,
    lastWinners: [],        // array of socketIds (for UI highlight)
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

  const guessesByName = Object.fromEntries(
    Array.from(g.guesses.entries()).map(([sid, val]) => {
      const name = room.players.get(sid)?.name || 'Player';
      return [name, val];
    })
  );

  const winnerNames = g.lastWinners.map(sid => room.players.get(sid)?.name || 'Player');

  io.to(code).emit('game:state', {
    players,
    phase: g.phase,
    currentTurnId: g.currentTurnId,
    isAcceptingPrompt: g.isAcceptingPrompt,
    prompt: g.prompt,
    targetValue: g.revealed ? g.targetValue : null, // hide until reveal
    answerText: g.revealed ? g.answerText : (g.phase === 'guessing' ? 'Answer locked. Guess now!' : ''),
    guessesByName,
    revealed: g.revealed,
    leaderboard: leaderboardArray(room),
    lastWinners: winnerNames,
  });
}

function pickRandomPlayerId(room) {
  const arr = roomPlayersArray(room);
  if (arr.length === 0) return null;
  const idx = Math.floor(Math.random() * arr.length);
  return arr[idx].id;
}

// -------------------- OpenAI numeric answer (robust) --------------------
// Uses JSON mode first, retries with clarified phrase if prompt had "ppg", then falls back to plain answer parsing.

async function fetchNumericAnswer(userPrompt) {
  // 1) Try JSON mode
  const first = await askForJsonNumber(userPrompt);
  if (first?.value != null && Number.isFinite(first.value)) return first;

  // 2) If prompt includes "ppg", clarify to "career points per game"
  if (/\bppg\b/i.test(userPrompt)) {
    const clarified = userPrompt.replace(/\bppg\b/ig, 'career points per game');
    const second = await askForJsonNumber(clarified);
    if (second?.value != null && Number.isFinite(second.value)) return second;
  }

  // 3) Fallback: plain “one number in sentence” then parse
  const text = await askForPlainNumber(userPrompt);
  const value = extractFirstNumber(text);
  return (value != null)
    ? { value, text: text || `Answer: ${value}` }
    : null;
}

async function askForJsonNumber(prompt) {
  const body = {
    model: 'gpt-4o-mini',
    temperature: 0,
    response_format: { type: 'json_object' }, // JSON mode
    messages: [
      {
        role: 'system',
        content: [
          'Return a JSON object with this shape:',
          '{ "value": <number|null>, "text": "<short sentence with the number and unit if any>" }',
          'If no numeric answer is possible, set value to null.',
        ].join(' ')
      },
      { role: 'user', content: prompt }
    ]
  };

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const errTxt = await resp.text().catch(()=>'');
    throw new Error(`OpenAI ${resp.status}: ${errTxt}`);
  }

  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content?.trim() || '';
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.value === 'number' || parsed?.value === null) {
      return { value: parsed.value, text: String(parsed.text || '') };
    }
  } catch {}
  return null;
}

async function askForPlainNumber(prompt) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'Answer in one short sentence that contains exactly ONE numeric value (and unit if applicable). If unknown, say: No numeric answer.'
        },
        { role: 'user', content: prompt }
      ]
    })
  });

  if (!resp.ok) {
    const errTxt = await resp.text().catch(()=>'');
    throw new Error(`OpenAI ${resp.status}: ${errTxt}`);
  }
  const data = await resp.json();
  return data?.choices?.[0]?.message?.content?.trim() || '';
}

/** Extract first integer/decimal (handles commas & thin spaces). */
function extractFirstNumber(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/[\u202F\u00A0,]/g, '');
  const m = cleaned.match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

// -------------------- Socket handlers --------------------
io.on('connection', (socket) => {
  // Join room
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

  // Lobby -> Game navigation
  socket.on('room:start', () => {
    const code = socket.data.code; const room = rooms.get(code);
    if (!room) return;
    if (room.hostId !== socket.id) return; // host only
    room.game = newGameState(); // reset round state, keep scores
    io.to(code).emit('room:started');
  });

  // Sync
  socket.on('game:sync', () => {
    const code = socket.data.code; if (!code) return;
    emitGameState(code);
  });

  // Host: start a round -> random chooser
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

  // Chooser sets prompt -> get numeric answer -> open guessing
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
      const result = await fetchNumericAnswer(prompt);

      if (!result || result.value == null || !Number.isFinite(result.value)) {
        g.phase = 'choosing'; // stay in choosing so host can try again
        g.answerText = 'No numeric answer found.';
        g.targetValue = null;
        emitGameState(code);
        return ack?.(false, 'No numeric answer found. Try rephrasing (e.g., "career points per game").');
      }

      g.targetValue = result.value;
      g.answerText  = result.text || `Answer: ${result.value}`;
      g.phase = 'guessing';
      g.guesses.clear();
      g.revealed = false;

      emitGameState(code);
      return ack?.(true);
    } catch (e) {
      console.error('fetchNumericAnswer error:', e);
      g.phase = 'choosing';
      emitGameState(code);
      return ack?.(false, 'Error fetching answer.');
    }
  });

  // Players submit guess
  socket.on('game:guess', (value, ack) => {
    const code = socket.data.code; const room = rooms.get(code);
    if (!room) return ack?.(false, 'Room missing');
    const g = room.game;
    if (g.phase !== 'guessing') return ack?.(false, 'Not accepting guesses');

    const v = Number(value);
    if (!Number.isFinite(v)) return ack?.(false, 'Guess must be a number');

    g.guesses.set(socket.id, v);
    emitGameState(code); // live count (values hidden by client until reveal)
    return ack?.(true);
  });

  // Host reveals & scores (closest gets 1 point; ties allowed)
  socket.on('game:revealAndScore', () => {
    const code = socket.data.code; const room = rooms.get(code);
    if (!room) return;
    if (room.hostId !== socket.id) return;
    const g = room.game;
    if (g.phase !== 'guessing') return;

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
    const winners = diffs.filter(d => d.err === minErr).map(d => d.sid);

    // Award 1 point to each winner
    for (const sid of winners) {
      const prev = room.scores.get(sid) || 0;
      room.scores.set(sid, prev + 1);
    }

    g.phase = 'revealed';
    g.revealed = true;
    g.lastWinners = winners;

    emitGameState(code);
  });

  // Disconnect handling
  socket.on('disconnect', () => {
    const code = socket.data.code; if (!code) return;
    const room = rooms.get(code); if (!room) return;

    room.players.delete(socket.id);

    if (room.hostId === socket.id) {
      const next = room.players.keys().next();
      room.hostId = next.done ? null : next.value;
    }

    // If chooser left, clear their turn
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

// -------------------- Start server --------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Lobby server running on http://localhost:${PORT}`));
