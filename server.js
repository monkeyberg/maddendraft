/*
 * Madden Startup Franchise Draft — server.
 * Express serves the app, Socket.io carries live picks, and every session is
 * saved to data/sessions/<ROOM>.json after each change so restarts are safe.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const E = require('./draft-engine');
const PlayerData = require('./player-data');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const SESS_DIR = path.join(DATA_DIR, 'sessions');
fs.mkdirSync(SESS_DIR, { recursive: true });

// ---------- Player pool ----------
function loadPool() {
  const custom = path.join(DATA_DIR, 'players.json');
  if (fs.existsSync(custom)) {
    const pool = E.normalizePool(JSON.parse(fs.readFileSync(custom, 'utf8')));
    console.log(`[pool] loaded ${pool.length} players from data/players.json`);
    return { pool, source: 'data/players.json' };
  }
  const pool = PlayerData.buildPool();
  console.log(`[pool] using built-in pool (${pool.length} players)`);
  return { pool, source: 'built-in' };
}
const { pool: POOL, source: POOL_SOURCE } = loadPool();
const POOL_MAP = E.indexPool(POOL);

// ---------- Sessions ----------
// sess = { state, members: { token: { name, teamId, isHost } }, online: Map<token, n>, timer, deadline }
const sessions = new Map();

function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from({ length: 5 }, () => chars[crypto.randomInt(chars.length)]).join(''); } while (sessions.has(c));
  return c;
}

function save(sess) {
  const file = path.join(SESS_DIR, sess.state.id + '.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ state: sess.state, members: sess.members }));
  fs.renameSync(tmp, file);
}

function loadSessions() {
  for (const f of fs.readdirSync(SESS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(SESS_DIR, f), 'utf8'));
      const sess = { state: data.state, members: data.members || {}, online: new Map(), timer: null, deadline: null };
      sessions.set(sess.state.id, sess);
    } catch (e) {
      console.warn('[sessions] could not load', f, e.message);
    }
  }
  console.log(`[sessions] restored ${sessions.size} session(s)`);
}

function publicView(sess) {
  return {
    state: sess.state,
    members: Object.entries(sess.members).map(([token, m]) => ({
      id: m.memberId || crypto.createHash('sha1').update(token).digest('hex').slice(0, 12),
      name: m.name, teamId: m.teamId, isHost: m.isHost, online: (sess.online.get(token) || 0) > 0
    })),
    deadline: sess.deadline,
    serverNow: Date.now()
  };
}

let io;
function broadcast(sess) { io.to(sess.state.id).emit('state', publicView(sess)); }

function after(sess) {
  save(sess);
  schedule(sess);
  broadcast(sess);
}

// Runs bots and the pick clock. The server is the only source of truth.
function schedule(sess) {
  clearTimeout(sess.timer);
  sess.timer = null;
  sess.deadline = null;
  const s = sess.state;
  if (s.status !== 'drafting' || s.paused) return;
  const oc = E.onClock(s);
  const team = E.getTeam(s, oc.teamId);
  if (team.isBot) {
    sess.timer = setTimeout(() => autoPick(sess, 'bot'), s.config.botDelayMs);
  } else if (s.config.pickTimer > 0) {
    sess.deadline = Date.now() + s.config.pickTimer * 1000;
    sess.timer = setTimeout(() => autoPick(sess, 'timer'), s.config.pickTimer * 1000);
  }
}

function autoPick(sess, by) {
  const s = sess.state;
  if (s.status !== 'drafting') return;
  const oc = E.onClock(s);
  const id = E.botChoose(s, POOL, POOL_MAP, oc.teamId);
  if (!id) {
    console.error(`[${s.id}] no legal player for ${oc.teamId}; pausing draft`);
    s.paused = true;
    return after(sess);
  }
  try {
    E.makePick(s, POOL_MAP, id, { by, force: by === 'host' });
  } catch (e) {
    console.error(`[${s.id}] autopick failed:`, e.message);
  }
  after(sess);
}

// ---------- HTTP ----------
const app = express();
app.use(express.json({ limit: '1mb' }));
// All app files sit next to server.js. Serve only these three, so nothing else
// in the folder (like saved sessions) is ever exposed.
const sendFile = name => (req, res) => res.sendFile(path.join(__dirname, name));
app.get(['/', '/index.html'], sendFile('index.html'));
app.get('/shared/draft-engine.js', sendFile('draft-engine.js'));
app.get('/shared/player-data.js', sendFile('player-data.js'));

app.get('/api/health', (req, res) => res.json({ ok: true, pool: POOL.length, poolSource: POOL_SOURCE, sessions: sessions.size }));
app.get('/api/pool', (req, res) => res.json(POOL));
app.get('/api/sessions/:id', (req, res) => {
  const sess = sessions.get(String(req.params.id).toUpperCase());
  if (!sess) return res.status(404).json({ error: 'Room not found' });
  res.json(publicView(sess));
});
app.get('/api/sessions/:id/export', (req, res) => {
  const sess = sessions.get(String(req.params.id).toUpperCase());
  if (!sess) return res.status(404).json({ error: 'Room not found' });
  res.setHeader('Content-Disposition', `attachment; filename="draft-${sess.state.id}.json"`);
  res.json(E.exportResults(sess.state, POOL_MAP));
});

const server = http.createServer(app);
io = new Server(server, { cors: { origin: true } });

// ---------- Sockets ----------
io.on('connection', socket => {
  const ctx = () => {
    const { roomId, token } = socket.data;
    const sess = roomId && sessions.get(roomId);
    const member = sess && sess.members[token];
    return { sess, member, token };
  };
  const fail = (ack, msg) => typeof ack === 'function' && ack({ ok: false, error: msg });
  const attach = (sess, token) => {
    if (socket.data.roomId) detach();
    socket.data.roomId = sess.state.id;
    socket.data.token = token;
    socket.join(sess.state.id);
    sess.online.set(token, (sess.online.get(token) || 0) + 1);
  };
  const detach = () => {
    const { sess, token } = ctx();
    if (!sess) return;
    sess.online.set(token, Math.max(0, (sess.online.get(token) || 1) - 1));
    socket.leave(sess.state.id);
    socket.data.roomId = null;
    broadcast(sess);
  };

  socket.on('room:create', (opts, ack) => {
    opts = opts || {};
    const numTeams = E.clampInt(opts.numTeams, 2, 32, 12);
    const check = E.validatePool(POOL, numTeams);
    if (!check.ok) return fail(ack, 'Player pool too small: ' + check.problems.join('; '));
    const id = roomCode();
    const state = E.createSession({
      id, numTeams, humanSlots: E.clampInt(opts.humanSlots, 1, numTeams, 2),
      seed: opts.seed, pickTimer: opts.pickTimer, botDelayMs: opts.botDelayMs
    });
    const name = String(opts.name || 'Commissioner').slice(0, 32);
    E.claimTeam(state, 'T1', name);
    const token = crypto.randomUUID();
    const sess = { state, members: { [token]: { memberId: crypto.randomUUID(), name, teamId: 'T1', isHost: true } }, online: new Map(), timer: null, deadline: null };
    sessions.set(id, sess);
    attach(sess, token);
    save(sess);
    ack && ack({ ok: true, roomId: id, token, memberId: sess.members[token].memberId, view: publicView(sess) });
    broadcast(sess);
  });

  socket.on('room:join', (opts, ack) => {
    opts = opts || {};
    const sess = sessions.get(String(opts.roomId || '').toUpperCase().trim());
    if (!sess) return fail(ack, 'No room with that code');
    let token = opts.token;
    if (!token || !sess.members[token]) {
      token = crypto.randomUUID();
      sess.members[token] = { memberId: crypto.randomUUID(), name: String(opts.name || 'Guest').slice(0, 32), teamId: null, isHost: false };
      save(sess);
    }
    attach(sess, token);
    const m = sess.members[token];
    if (!m.memberId) { m.memberId = crypto.randomUUID(); save(sess); }
    ack && ack({ ok: true, roomId: sess.state.id, token, memberId: m.memberId, view: publicView(sess) });
    broadcast(sess);
  });

  socket.on('room:leave', (_, ack) => { detach(); ack && ack({ ok: true }); });

  socket.on('team:claim', ({ teamId } = {}, ack) => {
    const { sess, member } = ctx();
    if (!member) return fail(ack, 'Join a room first');
    try {
      const t = E.getTeam(sess.state, teamId);
      const owned = Object.values(sess.members).some(m => m.teamId === teamId && m !== member);
      if (!t || t.isBot || owned) return fail(ack, 'That team is taken');
      if (member.teamId) E.releaseTeam(sess.state, member.teamId);
      E.claimTeam(sess.state, teamId, member.name);
      member.teamId = teamId;
      after(sess);
      ack && ack({ ok: true });
    } catch (e) { fail(ack, e.message); }
  });

  socket.on('team:release', (_, ack) => {
    const { sess, member } = ctx();
    if (!member || !member.teamId) return fail(ack, 'You have no team');
    if (sess.state.status !== 'lobby') return fail(ack, 'The draft has started');
    E.releaseTeam(sess.state, member.teamId);
    member.teamId = null;
    after(sess);
    ack && ack({ ok: true });
  });

  socket.on('draft:start', (_, ack) => {
    const { sess, member } = ctx();
    if (!member || !member.isHost) return fail(ack, 'Only the host can start the draft');
    try {
      E.startDraft(sess.state);
      after(sess);
      ack && ack({ ok: true });
    } catch (e) { fail(ack, e.message); }
  });

  socket.on('draft:pick', ({ playerId } = {}, ack) => {
    const { sess, member } = ctx();
    if (!member || !member.teamId) return fail(ack, 'You are not drafting for a team');
    try {
      const pick = E.makePick(sess.state, POOL_MAP, playerId, { teamId: member.teamId, by: 'human' });
      after(sess);
      ack && ack({ ok: true, pick });
    } catch (e) { fail(ack, e.message); }
  });

  socket.on('draft:autopick', (_, ack) => {
    const { sess, member } = ctx();
    if (!member) return fail(ack, 'Join a room first');
    const oc = E.onClock(sess.state);
    if (!oc) return fail(ack, 'The draft is not live');
    if (!member.isHost && member.teamId !== oc.teamId) return fail(ack, 'It is not your pick');
    autoPick(sess, member.isHost && member.teamId !== oc.teamId ? 'host' : 'auto');
    ack && ack({ ok: true });
  });

  socket.on('draft:pause', ({ paused } = {}, ack) => {
    const { sess, member } = ctx();
    if (!member || !member.isHost) return fail(ack, 'Only the host can pause');
    if (sess.state.status !== 'drafting') return fail(ack, 'The draft is not live');
    sess.state.paused = !!paused;
    after(sess);
    ack && ack({ ok: true });
  });

  socket.on('draft:undo', (_, ack) => {
    const { sess, member } = ctx();
    if (!member || !member.isHost) return fail(ack, 'Only the host can undo picks');
    try {
      E.undoLastPick(sess.state);
      sess.state.paused = true; // stop bots from instantly re-picking
      after(sess);
      ack && ack({ ok: true });
    } catch (e) { fail(ack, e.message); }
  });

  socket.on('disconnect', () => {
    const { sess, token } = ctx();
    if (!sess) return;
    sess.online.set(token, Math.max(0, (sess.online.get(token) || 1) - 1));
    broadcast(sess);
  });
});

loadSessions();
for (const sess of sessions.values()) schedule(sess);

server.listen(PORT, () => {
  console.log(`Madden Startup Franchise Draft running at http://localhost:${PORT}`);
});

module.exports = { server, sessions };
