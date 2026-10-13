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
// sess = { state, members: { sha256(token): { memberId, name, teamId, isHost } }, room, online: Map<key, n>,
//          timer, deadline, pickLog }
// Members are keyed by a hash of their token, so the raw token is never written to disk.
const sessions = new Map();
const MAX_MEMBERS = 64;
const PICK_LOG = 50; // recent picks kept in memory for reconnect replay
const IDLE_MS = 14 * 24 * 60 * 60 * 1000;
const V2 = id => id + ':v2'; // socket.io room for clients that take per-pick deltas

const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const isTokenHash = k => /^[0-9a-f]{64}$/.test(k);

function hashPass(pass) {
  const salt = crypto.randomBytes(16);
  return 'scrypt$' + salt.toString('hex') + '$' + crypto.scryptSync(String(pass), salt, 32).toString('hex');
}
function checkPass(stored, pass) {
  const [, salt, hash] = stored.split('$');
  const got = crypto.scryptSync(String(pass || ''), Buffer.from(salt, 'hex'), 32);
  return crypto.timingSafeEqual(got, Buffer.from(hash, 'hex'));
}

function newRoom(passcode) {
  return { rev: 0, passHash: passcode ? hashPass(passcode) : null, maxMembers: MAX_MEMBERS, lastActiveAt: Date.now() };
}

// Fixed-window counters per client IP: room creation and failed joins.
const limits = new Map();
function hits(key) {
  const b = limits.get(key);
  return b && b.resetAt > Date.now() ? b.n : 0;
}
function hit(key) {
  const now = Date.now();
  let b = limits.get(key);
  if (!b || b.resetAt <= now) { b = { n: 0, resetAt: now + 60000 }; limits.set(key, b); }
  return ++b.n;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of limits) if (b.resetAt <= now) limits.delete(k); }, 60000).unref();

function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from({ length: 5 }, () => chars[crypto.randomInt(chars.length)]).join(''); } while (sessions.has(c));
  return c;
}

function save(sess) {
  const file = path.join(SESS_DIR, sess.state.id + '.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ state: sess.state, members: sess.members, room: sess.room }));
  fs.renameSync(tmp, file);
}

function loadSessions() {
  for (const f of fs.readdirSync(SESS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(SESS_DIR, f), 'utf8'));
      const sess = {
        state: data.state, members: {}, online: new Map(), timer: null, deadline: null, pickLog: [],
        room: Object.assign(newRoom(), { lastActiveAt: data.state.createdAt || Date.now() }, data.room)
      };
      // Older files keyed members by their raw token. Rehash them once.
      let migrated = !data.room;
      for (const [k, m] of Object.entries(data.members || {})) {
        if (!m.memberId) { m.memberId = crypto.randomUUID(); migrated = true; }
        if (isTokenHash(k)) sess.members[k] = m;
        else { sess.members[hashToken(k)] = m; migrated = true; }
      }
      sessions.set(sess.state.id, sess);
      if (migrated) save(sess);
    } catch (e) {
      console.warn('[sessions] could not load', f, e.message);
    }
  }
  console.log(`[sessions] restored ${sessions.size} session(s)`);
}

function publicView(sess) {
  return {
    state: sess.state,
    members: memberList(sess),
    deadline: sess.deadline,
    serverNow: Date.now(),
    rev: sess.room.rev
  };
}
function memberList(sess) {
  return Object.entries(sess.members).map(([key, m]) => ({
    id: m.memberId, name: m.name, teamId: m.teamId, isHost: m.isHost, online: (sess.online.get(key) || 0) > 0
  }));
}

let io;
const hasSockets = room => (io.sockets.adapter.rooms.get(room) || { size: 0 }).size > 0;

// Full state to everyone. Used for lobby, pause and undo changes.
function broadcast(sess) { io.to(sess.state.id).to(V2(sess.state.id)).emit('state', publicView(sess)); }

// Who is in the room and online. Older clients still get the full state.
function presence(sess) {
  const id = sess.state.id;
  if (hasSockets(V2(id))) io.to(V2(id)).emit('presence', { rev: sess.room.rev, members: memberList(sess) });
  if (hasSockets(id)) io.to(id).emit('state', publicView(sess));
}

// Every state change goes through here: bump rev, save, rearm the clock, notify.
// A pick goes out as a small delta; anything else as the full state.
function commit(sess, pick) {
  sess.room.rev++;
  sess.room.lastActiveAt = Date.now();
  save(sess);
  schedule(sess);
  if (!pick) return broadcast(sess);
  const id = sess.state.id;
  sess.pickLog.push({ rev: sess.room.rev, pick });
  if (sess.pickLog.length > PICK_LOG) sess.pickLog.shift();
  io.to(V2(id)).emit('draft:picked', {
    rev: sess.room.rev, pick, deadline: sess.deadline, serverNow: Date.now(),
    status: sess.state.status, paused: sess.state.paused
  });
  if (hasSockets(id)) io.to(id).emit('state', publicView(sess));
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
    return commit(sess);
  }
  let pick = null;
  try {
    pick = E.makePick(s, POOL_MAP, id, { by, force: by === 'host' });
  } catch (e) {
    console.error(`[${s.id}] autopick failed:`, e.message);
  }
  commit(sess, pick);
}

function deleteSession(sess) {
  clearTimeout(sess.timer);
  sessions.delete(sess.state.id);
  try { fs.unlinkSync(path.join(SESS_DIR, sess.state.id + '.json')); } catch (e) { /* already gone */ }
}

// Hourly: drop rooms nobody has touched for 14 days.
setInterval(() => {
  const cutoff = Date.now() - IDLE_MS;
  for (const sess of sessions.values()) {
    if (sess.room.lastActiveAt < cutoff && ![...sess.online.values()].some(n => n > 0)) {
      console.log(`[${sess.state.id}] expired after 14 idle days`);
      deleteSession(sess);
    }
  }
}, 60 * 60 * 1000).unref();

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
  const token = req.get('X-Room-Token');
  if (!token || !sess.members[hashToken(token)]) return res.status(403).json({ error: 'Join the room to see it' });
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
// Behind a proxy (Render) every socket shares the proxy's address, so prefer the
// forwarded client address. A spoofed header only dodges the limiter for that client.
function clientIp(socket) {
  const fwd = socket.handshake.headers['x-forwarded-for'];
  return (fwd ? String(fwd).split(',')[0] : socket.handshake.address).trim();
}

io.on('connection', socket => {
  const ip = clientIp(socket);
  const ctx = () => {
    const { roomId, key } = socket.data;
    const sess = roomId && sessions.get(roomId);
    const member = sess && sess.members[key];
    return { sess, member, key };
  };
  const fail = (ack, msg) => typeof ack === 'function' && ack({ ok: false, error: msg });
  const attach = (sess, key, proto) => {
    if (socket.data.roomId) detach();
    socket.data.roomId = sess.state.id;
    socket.data.key = key;
    socket.join(proto === 2 ? V2(sess.state.id) : sess.state.id);
    sess.online.set(key, (sess.online.get(key) || 0) + 1);
  };
  const detach = () => {
    const { sess, key } = ctx();
    if (!sess) return;
    sess.online.set(key, Math.max(0, (sess.online.get(key) || 1) - 1));
    socket.leave(sess.state.id);
    socket.leave(V2(sess.state.id));
    socket.data.roomId = null;
    presence(sess);
  };
  const hostAction = (ack) => {
    const { sess, member } = ctx();
    if (!member || !member.isHost) { fail(ack, 'Only the host can do that'); return null; }
    return { sess, member };
  };
  const findMember = (sess, memberId) => Object.entries(sess.members).find(([, m]) => m.memberId === memberId);

  socket.on('room:create', (opts, ack) => {
    opts = opts || {};
    if (hit('create:' + ip) > 10) return fail(ack, 'Too many rooms created. Try again in a minute.');
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
    const key = hashToken(token);
    const passcode = String(opts.passcode || '').slice(0, 64);
    const sess = {
      state, members: { [key]: { memberId: crypto.randomUUID(), name, teamId: 'T1', isHost: true } },
      room: newRoom(passcode), online: new Map(), timer: null, deadline: null, pickLog: []
    };
    sessions.set(id, sess);
    attach(sess, key, opts.proto);
    save(sess);
    ack && ack({ ok: true, roomId: id, token, memberId: sess.members[key].memberId, rev: sess.room.rev, view: publicView(sess) });
    presence(sess);
  });

  socket.on('room:join', (opts, ack) => {
    opts = opts || {};
    const failJoin = msg => { hit('join:' + ip); fail(ack, msg); };
    if (hits('join:' + ip) >= 10) return fail(ack, 'Too many failed attempts. Try again in a minute.');
    const sess = sessions.get(String(opts.roomId || '').toUpperCase().trim());
    if (!sess) return failJoin('No room with that code');
    let token = opts.token;
    let key = token && hashToken(token);
    if (!key || !sess.members[key]) {
      if (sess.room.passHash && !checkPass(sess.room.passHash, opts.passcode)) {
        return failJoin(opts.passcode ? 'Wrong passcode' : 'This room needs a passcode');
      }
      if (Object.keys(sess.members).length >= sess.room.maxMembers) return fail(ack, 'This room is full');
      token = crypto.randomUUID();
      key = hashToken(token);
      sess.members[key] = { memberId: crypto.randomUUID(), name: String(opts.name || 'Guest').slice(0, 32), teamId: null, isHost: false };
    }
    sess.room.lastActiveAt = Date.now();
    save(sess);
    attach(sess, key, opts.proto);
    const m = sess.members[key];
    const res = { ok: true, roomId: sess.state.id, token, memberId: m.memberId, rev: sess.room.rev };
    // A client coming back can catch up on the picks it missed, if they are all still in the log.
    const lastRev = opts.lastRev == null ? NaN : Number(opts.lastRev);
    const missed = opts.proto === 2 && Number.isInteger(lastRev) ? sess.pickLog.filter(e => e.rev > lastRev) : null;
    if (missed && lastRev <= sess.room.rev && missed.length === sess.room.rev - lastRev) {
      Object.assign(res, { missed, members: memberList(sess), deadline: sess.deadline, serverNow: Date.now(), paused: sess.state.paused });
    } else {
      res.view = publicView(sess);
    }
    ack && ack(res);
    presence(sess);
  });

  socket.on('room:sync', (_, ack) => {
    const { sess, member } = ctx();
    if (!member) return fail(ack, 'Join a room first');
    ack && ack({ ok: true, rev: sess.room.rev, view: publicView(sess) });
  });

  socket.on('room:leave', (_, ack) => { detach(); ack && ack({ ok: true }); });

  socket.on('member:kick', async ({ memberId } = {}, ack) => {
    const h = hostAction(ack);
    if (!h) return;
    const { sess, member } = h;
    const found = findMember(sess, memberId);
    if (!found) return fail(ack, 'No such member');
    const [key, target] = found;
    if (target === member) return fail(ack, 'You cannot remove yourself');
    if (target.teamId && sess.state.status === 'lobby') E.releaseTeam(sess.state, target.teamId);
    delete sess.members[key];
    sess.online.delete(key);
    for (const s of await io.in([sess.state.id, V2(sess.state.id)]).fetchSockets()) {
      if (s.data.key !== key) continue;
      s.emit('room:kicked', {});
      s.data.roomId = null;
      s.disconnect(true);
    }
    commit(sess);
    ack && ack({ ok: true });
  });

  socket.on('host:transfer', ({ memberId } = {}, ack) => {
    const h = hostAction(ack);
    if (!h) return;
    const { sess, member } = h;
    const found = findMember(sess, memberId);
    if (!found || found[1] === member) return fail(ack, 'Pick another member');
    member.isHost = false;
    found[1].isHost = true;
    commit(sess);
    ack && ack({ ok: true });
  });

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
      commit(sess);
      ack && ack({ ok: true });
    } catch (e) { fail(ack, e.message); }
  });

  socket.on('team:release', (_, ack) => {
    const { sess, member } = ctx();
    if (!member || !member.teamId) return fail(ack, 'You have no team');
    if (sess.state.status !== 'lobby') return fail(ack, 'The draft has started');
    E.releaseTeam(sess.state, member.teamId);
    member.teamId = null;
    commit(sess);
    ack && ack({ ok: true });
  });

  socket.on('draft:start', (_, ack) => {
    const { sess, member } = ctx();
    if (!member || !member.isHost) return fail(ack, 'Only the host can start the draft');
    try {
      E.startDraft(sess.state);
      commit(sess);
      ack && ack({ ok: true });
    } catch (e) { fail(ack, e.message); }
  });

  socket.on('draft:pick', ({ playerId } = {}, ack) => {
    const { sess, member } = ctx();
    if (!member || !member.teamId) return fail(ack, 'You are not drafting for a team');
    try {
      const pick = E.makePick(sess.state, POOL_MAP, playerId, { teamId: member.teamId, by: 'human' });
      commit(sess, pick);
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
    commit(sess);
    ack && ack({ ok: true });
  });

  socket.on('draft:undo', (_, ack) => {
    const { sess, member } = ctx();
    if (!member || !member.isHost) return fail(ack, 'Only the host can undo picks');
    try {
      E.undoLastPick(sess.state);
      sess.state.paused = true; // stop bots from instantly re-picking
      commit(sess);
      ack && ack({ ok: true });
    } catch (e) { fail(ack, e.message); }
  });

  socket.on('disconnect', () => {
    const { sess, key } = ctx();
    if (!sess) return;
    sess.online.set(key, Math.max(0, (sess.online.get(key) || 1) - 1));
    presence(sess);
  });
});

loadSessions();
for (const sess of sessions.values()) schedule(sess);

server.listen(PORT, () => {
  console.log(`Madden Startup Franchise Draft running at http://localhost:${PORT}`);
});

module.exports = { server, sessions };
