/*
 * Madden Startup Franchise Draft — shared draft engine.
 * Pure logic, no I/O. Runs in the browser (window.DraftEngine) and in Node (require).
 * The server and the local (solo / couch) client both use this file, so the rules
 * are identical everywhere.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DraftEngine = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ROUNDS = 25;
  const OFF = ['QB', 'RB', 'WR', 'TE', 'OT', 'OG', 'C'];
  const DEF = ['EDGE', 'IDL', 'LB', 'CB', 'S'];
  const ALL_POS = OFF.concat(DEF);
  const POS_NAMES = {
    QB: 'Quarterback', RB: 'Running back', WR: 'Wide receiver', TE: 'Tight end',
    OT: 'Offensive tackle', OG: 'Guard', C: 'Center', EDGE: 'Edge rusher',
    IDL: 'Interior D-line', LB: 'Linebacker', CB: 'Cornerback', S: 'Safety'
  };

  // Raw position labels (Madden / NFL style) -> roster group.
  const POS_ALIASES = {
    QB: 'QB', HB: 'RB', RB: 'RB', FB: 'RB', WR: 'WR', TE: 'TE',
    LT: 'OT', RT: 'OT', OT: 'OT', T: 'OT', LG: 'OG', RG: 'OG', OG: 'OG', G: 'OG', IOL: 'OG', C: 'C',
    DE: 'EDGE', LE: 'EDGE', RE: 'EDGE', EDGE: 'EDGE', LEDG: 'EDGE', REDG: 'EDGE',
    DT: 'IDL', IDL: 'IDL', NT: 'IDL', DL: 'IDL',
    MLB: 'LB', ILB: 'LB', OLB: 'LB', LOLB: 'LB', ROLB: 'LB', SAM: 'LB', WILL: 'LB', MIKE: 'LB', LB: 'LB',
    CB: 'CB', NB: 'CB', FS: 'S', SS: 'S', S: 'S', DB: 'S'
  };

  function slot(key, label, pos, unit, pref) {
    return { key, label, unit, accepts: [pos], pref: pref || null, flex: false };
  }

  // The 25-man template. Order matters: it is the display order of the depth chart.
  const SLOTS = [
    slot('QB', 'QB', 'QB', 'OFF'),
    slot('RB', 'HB', 'RB', 'OFF'),
    slot('WR1', 'WR1', 'WR', 'OFF'), slot('WR2', 'WR2', 'WR', 'OFF'), slot('WR3', 'WR3', 'WR', 'OFF'),
    slot('TE1', 'TE1', 'TE', 'OFF'), slot('TE2', 'TE2', 'TE', 'OFF'),
    slot('LT', 'LT', 'OT', 'OFF', 'LT'), slot('RT', 'RT', 'OT', 'OFF', 'RT'),
    slot('LG', 'LG', 'OG', 'OFF', 'LG'), slot('RG', 'RG', 'OG', 'OFF', 'RG'),
    slot('C', 'C', 'C', 'OFF'),
    slot('LEDG', 'LEDG', 'EDGE', 'DEF', 'LE'), slot('REDG', 'REDG', 'EDGE', 'DEF', 'RE'),
    slot('DT1', 'DT1', 'IDL', 'DEF'), slot('DT2', 'DT2', 'IDL', 'DEF'),
    slot('MLB', 'MLB', 'LB', 'DEF', 'MLB'), slot('OLB', 'OLB', 'LB', 'DEF', 'OLB'),
    slot('CB1', 'CB1', 'CB', 'DEF'), slot('CB2', 'CB2', 'CB', 'DEF'), slot('CB3', 'CB3', 'CB', 'DEF'),
    slot('FS', 'FS', 'S', 'DEF', 'FS'), slot('SS', 'SS', 'S', 'DEF', 'SS'),
    { key: 'OFLEX', label: 'Off. backup', unit: 'BENCH', accepts: OFF.slice(), pref: null, flex: true, side: 'OFF' },
    { key: 'DFLEX', label: 'Def. backup', unit: 'BENCH', accepts: DEF.slice(), pref: null, flex: true, side: 'DEF' }
  ];
  if (SLOTS.length !== ROUNDS) throw new Error('Slot template must have exactly 25 slots');

  // Required dedicated (starter) count per position group.
  const REQUIRED = {};
  ALL_POS.forEach(p => { REQUIRED[p] = 0; });
  SLOTS.forEach(s => { if (!s.flex) REQUIRED[s.accepts[0]]++; });

  const STRATEGIES = {
    balanced: { label: 'Balanced', jitter: 2, need: 0.6, premium: { QB: 3, EDGE: 2, WR: 1, OT: 1, CB: 1, RB: 0, TE: 0, IDL: 0.5, LB: -1, S: -1, OG: -1, C: -2 } },
    bpa: { label: 'Best available', jitter: 1, need: 0, premium: {} },
    trenches: { label: 'Trenches first', jitter: 2, need: 0.4, premium: { QB: 2, OT: 3, OG: 2, C: 1, EDGE: 3, IDL: 3, RB: -2, WR: -1, TE: -1, LB: -1, CB: -1, S: -2 } },
    skill: { label: 'Skill and speed', jitter: 2, need: 0.4, premium: { QB: 4, WR: 3, RB: 2, TE: 2, CB: 1, S: 0, OT: -1, OG: -3, C: -3, EDGE: 0, IDL: -2, LB: -1 } },
    needs: { label: 'Needs-based', jitter: 1.5, need: 2, premium: { QB: 2, EDGE: 1, WR: 1, OT: 1, CB: 1 } }
  };
  const BOT_STRATS = ['balanced', 'bpa', 'trenches', 'skill', 'needs'];
  const ADP_PREMIUM = STRATEGIES.balanced.premium;

  const BOT_TEAMS = [
    'Albuquerque Roadrunners', 'Birmingham Ironclads', 'Boise Blizzard', 'Charleston Tidecallers',
    'El Paso Outlaws', 'Hartford Harbormasters', 'Honolulu Breakers', 'Louisville Thoroughbreds',
    'Oklahoma City Twisters', 'Omaha Stockmen', 'Orlando Comets', 'Portland Lumberjacks',
    'Sacramento Gold', 'Salt Lake Summit', 'San Antonio Vaqueros', 'San Diego Surf',
    'St. Louis Archers', 'Toronto Northmen', 'Mexico City Aztecs', 'London Knights',
    'Austin Armadillos', 'Columbus Foundry', 'Raleigh Oaks', 'Richmond Riverhawks',
    'Anchorage Aurora', 'Spokane Sentinels', 'Tulsa Wildcatters', 'Milwaukee Brewmasters',
    'Norfolk Navigators', 'Reno Highrollers', 'Montreal Voyageurs', 'Fresno Firebirds'
  ];

  // ---------- Seedable PRNG (cyrb128-style hash -> mulberry32) ----------
  function hashSeed(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function createRng(seed) { return mulberry32(hashSeed(String(seed))); }
  function shuffle(arr, rng) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function randomSeed() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 8; i++) {
      if (i === 4) s += '-';
      s += chars[Math.floor(Math.random() * chars.length)];
    }
    return s;
  }

  // ---------- Helpers ----------
  function err(msg, code) { const e = new Error(msg); e.code = code || 'RULE'; return e; }
  function clampInt(v, lo, hi, dflt) {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) return dflt;
    return Math.max(lo, Math.min(hi, n));
  }
  function getTeam(state, teamId) { return state.teams.find(t => t.id === teamId) || null; }

  // ---------- Player pool ----------
  function normalizePool(raw, opts) {
    if (!Array.isArray(raw)) throw err('Player pool must be a JSON array of players', 'POOL');
    const rng = createRng((opts && opts.seed) || 'adp');
    const out = [];
    const seen = new Set();
    raw.forEach((r, i) => {
      if (!r || !r.name || !r.pos) return;
      const detail = String(r.pos).toUpperCase().trim();
      const pos = POS_ALIASES[detail];
      if (!pos) return; // skip K, P, LS, etc.
      let id = r.id != null ? String(r.id) : 'P' + String(i + 1).padStart(4, '0');
      while (seen.has(id)) id += 'x';
      seen.add(id);
      const ovr = clampInt(r.ovr != null ? r.ovr : r.overall, 40, 99, 60);
      out.push({
        id, name: String(r.name).trim(), team: String(r.team || 'FA').toUpperCase().slice(0, 4),
        pos, detail, ovr, adp: r.adp != null ? Number(r.adp) : null
      });
    });
    if (out.some(p => p.adp == null || Number.isNaN(p.adp))) computeAdp(out, rng);
    out.sort((a, b) => a.adp - b.adp);
    return out;
  }
  function computeAdp(pool, rng) {
    const scored = pool.map(p => ({ p, v: p.ovr + (ADP_PREMIUM[p.pos] || 0) + (rng() - 0.5) * 3 }));
    scored.sort((a, b) => b.v - a.v);
    scored.forEach((s, i) => { s.p.adp = i + 1; });
    return pool;
  }
  function indexPool(pool) {
    const map = Object.create(null);
    pool.forEach(p => { map[p.id] = p; });
    return map;
  }
  // Checks that a pool can complete a draft for numTeams teams.
  function validatePool(pool, numTeams) {
    const counts = {};
    ALL_POS.forEach(p => { counts[p] = 0; });
    pool.forEach(p => { counts[p.pos]++; });
    const problems = [];
    ALL_POS.forEach(p => {
      const need = REQUIRED[p] * numTeams;
      if (counts[p] < need) problems.push(`${POS_NAMES[p]}: ${counts[p]} in pool, need at least ${need}`);
    });
    const offNeed = OFF.reduce((s, p) => s + REQUIRED[p], 0) * numTeams + numTeams;
    const defNeed = DEF.reduce((s, p) => s + REQUIRED[p], 0) * numTeams + numTeams;
    const offHave = OFF.reduce((s, p) => s + counts[p], 0);
    const defHave = DEF.reduce((s, p) => s + counts[p], 0);
    if (offHave < offNeed) problems.push(`Offense: ${offHave} players, need ${offNeed}`);
    if (defHave < defNeed) problems.push(`Defense: ${defHave} players, need ${defNeed}`);
    return { ok: problems.length === 0, problems, counts };
  }

  // ---------- Session lifecycle ----------
  function createSession(opts) {
    opts = opts || {};
    const n = clampInt(opts.numTeams, 2, 32, 12);
    const humans = clampInt(opts.humanSlots, 0, n, 1);
    const names = opts.humanNames || [];
    const teams = [];
    for (let i = 0; i < n; i++) {
      const human = i < humans;
      teams.push({
        id: 'T' + (i + 1),
        name: human ? (names[i] || '') : BOT_TEAMS[i % BOT_TEAMS.length],
        isBot: !human,
        claimed: human ? !!names[i] : true,
        strategy: human ? null : BOT_STRATS[i % BOT_STRATS.length],
        slots: new Array(SLOTS.length).fill(null)
      });
    }
    return {
      version: 1,
      id: opts.id || null,
      seed: String(opts.seed || randomSeed()),
      createdAt: Date.now(),
      status: 'lobby',
      paused: false,
      config: {
        numTeams: n, humanSlots: humans, rounds: ROUNDS,
        pickTimer: clampInt(opts.pickTimer, 0, 600, 0),
        botDelayMs: clampInt(opts.botDelayMs, 0, 10000, 700)
      },
      teams, order: [], picks: [], drafted: {}, currentPick: 0
    };
  }

  function claimTeam(state, teamId, name) {
    if (state.status !== 'lobby') throw err('Teams can only be claimed before the draft starts');
    const t = getTeam(state, teamId);
    if (!t || t.isBot) throw err('That team slot is not open to humans');
    t.name = String(name || 'Drafter').slice(0, 32);
    t.claimed = true;
    return t;
  }
  function releaseTeam(state, teamId) {
    const t = getTeam(state, teamId);
    if (t && !t.isBot && state.status === 'lobby') { t.claimed = false; t.name = ''; }
  }

  // Randomizes the round-1 order from the seed and opens the draft.
  function startDraft(state) {
    if (state.status !== 'lobby') throw err('Draft already started');
    let b = 0;
    state.teams.forEach(t => {
      if (!t.isBot && !t.claimed) {
        t.isBot = true;
        t.claimed = true;
        t.name = BOT_TEAMS[(state.teams.length + b) % BOT_TEAMS.length] + ' (auto)';
        t.strategy = BOT_STRATS[b % BOT_STRATS.length];
        b++;
      }
    });
    const rng = createRng(state.seed + '|order');
    state.order = shuffle(state.teams.map(t => t.id), rng);
    state.status = 'drafting';
    state.startedAt = Date.now();
    state.currentPick = 0;
    return state;
  }

  // Snake order: odd rounds go 1 -> N, even rounds go N -> 1.
  function pickInfo(state, overallIndex) {
    const n = state.teams.length;
    const round = Math.floor(overallIndex / n) + 1;
    const i = overallIndex % n;
    const pos = round % 2 === 1 ? i : n - 1 - i;
    return { overall: overallIndex + 1, round, pickInRound: i + 1, teamId: state.order[pos] };
  }
  function totalPicks(state) { return state.teams.length * ROUNDS; }
  function onClock(state) {
    if (state.status !== 'drafting') return null;
    return pickInfo(state, state.currentPick);
  }
  function upcoming(state, count) {
    const out = [];
    const end = Math.min(totalPicks(state), state.currentPick + count);
    for (let i = state.currentPick; i < end; i++) out.push(pickInfo(state, i));
    return out;
  }

  // ---------- Roster constraints ----------
  // Returns the slot index this player would fill for the team, or -1 if illegal.
  // Order: dedicated slot matching the player's listed spot (LT -> LT), any dedicated
  // slot for the group, then the side's bench/flex slot.
  function findSlotIndex(team, player) {
    let firstDedicated = -1;
    for (let i = 0; i < SLOTS.length; i++) {
      const s = SLOTS[i];
      if (team.slots[i] || s.flex || s.accepts[0] !== player.pos) continue;
      if (s.pref && s.pref === player.detail) return i;
      if (firstDedicated < 0) firstDedicated = i;
    }
    if (firstDedicated >= 0) return firstDedicated;
    for (let i = 0; i < SLOTS.length; i++) {
      const s = SLOTS[i];
      if (!team.slots[i] && s.flex && s.accepts.indexOf(player.pos) >= 0) return i;
    }
    return -1;
  }
  function canDraft(team, player) { return findSlotIndex(team, player) >= 0; }
  function openNeeds(team) {
    const needs = {};
    ALL_POS.forEach(p => { needs[p] = 0; });
    SLOTS.forEach((s, i) => { if (!s.flex && !team.slots[i]) needs[s.accepts[0]]++; });
    return needs;
  }
  function openFlex(team) {
    return SLOTS.filter((s, i) => s.flex && !team.slots[i]).map(s => s.side);
  }
  function filledCount(team) { return team.slots.filter(Boolean).length; }

  // ---------- Picks ----------
  function makePick(state, poolMap, playerId, meta) {
    meta = meta || {};
    if (state.status !== 'drafting') throw err('The draft is not live');
    if (state.paused && !meta.force) throw err('The draft is paused');
    const info = onClock(state);
    if (meta.teamId && meta.teamId !== info.teamId) throw err('It is not your pick');
    const player = poolMap[playerId];
    if (!player) throw err('Unknown player');
    if (state.drafted[playerId]) throw err(player.name + ' is already drafted');
    const team = getTeam(state, info.teamId);
    const si = findSlotIndex(team, player);
    if (si < 0) throw err('No open roster slot for a ' + POS_NAMES[player.pos].toLowerCase());
    team.slots[si] = playerId;
    state.drafted[playerId] = team.id;
    const pick = {
      overall: info.overall, round: info.round, pickInRound: info.pickInRound,
      teamId: team.id, playerId, slot: SLOTS[si].key, by: meta.by || 'human', ts: Date.now()
    };
    state.picks.push(pick);
    state.currentPick++;
    if (state.currentPick >= totalPicks(state)) {
      state.status = 'complete';
      state.completedAt = Date.now();
    }
    return pick;
  }
  function undoLastPick(state) {
    const pick = state.picks.pop();
    if (!pick) throw err('No picks to undo');
    const team = getTeam(state, pick.teamId);
    const si = team.slots.indexOf(pick.playerId);
    if (si >= 0) team.slots[si] = null;
    delete state.drafted[pick.playerId];
    state.currentPick--;
    state.status = 'drafting';
    delete state.completedAt;
    return pick;
  }

  // Bot / auto-pick brain. Deterministic for a given seed + pick number.
  function botChoose(state, pool, poolMap, teamId, opts) {
    opts = opts || {};
    const team = getTeam(state, teamId);
    if (!team) return null;
    if (opts.queue) {
      for (const id of opts.queue) {
        const p = poolMap[id];
        if (p && !state.drafted[id] && canDraft(team, p)) return id;
      }
    }
    const strat = STRATEGIES[opts.strategy || team.strategy] || STRATEGIES.balanced;
    const rng = createRng(state.seed + '|pick|' + state.currentPick + '|' + teamId);
    const roundsLeft = ROUNDS - filledCount(team);
    const needs = openNeeds(team);
    let best = null;
    let bestScore = -Infinity;
    for (const p of pool) {
      if (state.drafted[p.id]) continue;
      const si = findSlotIndex(team, p);
      if (si < 0) continue;
      let s = p.ovr + (strat.premium[p.pos] || 0);
      if (SLOTS[si].flex) s -= 4 + roundsLeft * 0.5;
      s += strat.need * (needs[p.pos] || 0);
      s += (rng() * 2 - 1) * strat.jitter;
      s -= p.adp * 0.0005;
      if (s > bestScore) { bestScore = s; best = p; }
    }
    return best ? best.id : null;
  }

  // ---------- Reporting ----------
  function teamSummary(state, poolMap, teamId) {
    const team = getTeam(state, teamId);
    const sum = { OFF: [0, 0], DEF: [0, 0], ALL: [0, 0] };
    SLOTS.forEach((s, i) => {
      const p = team.slots[i] && poolMap[team.slots[i]];
      if (!p || s.flex) return;
      sum[s.unit][0] += p.ovr; sum[s.unit][1]++;
      sum.ALL[0] += p.ovr; sum.ALL[1]++;
    });
    const avg = a => (a[1] ? Math.round((a[0] / a[1]) * 10) / 10 : null);
    return { teamId, filled: filledCount(team), off: avg(sum.OFF), def: avg(sum.DEF), starters: avg(sum.ALL) };
  }
  function leagueTable(state, poolMap) {
    const rows = state.teams.map(t => Object.assign({ name: t.name, isBot: t.isBot }, teamSummary(state, poolMap, t.id)));
    rows.sort((a, b) => (b.starters || 0) - (a.starters || 0));
    const n = rows.length;
    const grades = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D'];
    rows.forEach((r, i) => {
      r.rank = i + 1;
      r.grade = grades[Math.min(grades.length - 1, Math.floor((i / n) * grades.length))];
    });
    return rows;
  }
  function exportResults(state, poolMap) {
    const name = id => (getTeam(state, id) || {}).name;
    return {
      app: 'Madden Startup Franchise Draft',
      seed: state.seed,
      config: state.config,
      status: state.status,
      draftOrder: state.order.map((id, i) => ({ slot: i + 1, teamId: id, team: name(id) })),
      picks: state.picks.map(pk => {
        const p = poolMap[pk.playerId] || {};
        return { overall: pk.overall, round: pk.round, pick: pk.pickInRound, team: name(pk.teamId), player: p.name, pos: p.detail, nflTeam: p.team, ovr: p.ovr, slot: pk.slot, by: pk.by };
      }),
      rosters: state.teams.map(t => ({
        team: t.name, bot: t.isBot,
        roster: SLOTS.map((s, i) => {
          const p = t.slots[i] && poolMap[t.slots[i]];
          return { slot: s.key, unit: s.unit, player: p ? p.name : null, pos: p ? p.detail : null, ovr: p ? p.ovr : null };
        })
      })),
      standings: leagueTable(state, poolMap)
    };
  }

  return {
    ROUNDS, OFF, DEF, ALL_POS, POS_NAMES, POS_ALIASES, SLOTS, REQUIRED, STRATEGIES, BOT_TEAMS,
    createRng, shuffle, randomSeed, hashSeed, clampInt, getTeam,
    normalizePool, computeAdp, indexPool, validatePool,
    createSession, claimTeam, releaseTeam, startDraft,
    pickInfo, totalPicks, onClock, upcoming,
    findSlotIndex, canDraft, openNeeds, openFlex, filledCount,
    makePick, undoLastPick, botChoose,
    teamSummary, leagueTable, exportResults
  };
});
