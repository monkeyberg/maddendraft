/*
 * Madden Startup Franchise — shared season engine.
 * Pure logic, no I/O. Runs in the browser (window.MaddenSeason) and in Node
 * (require). Builds a round-robin schedule from drafted rosters, simulates
 * games from roster strength, and runs a seeded playoff bracket.
 *
 * A season lives on the draft state as `state.season`:
 *   { status, weeks, cur, playoffs }
 * status: 'regular' -> 'playoffs' -> 'complete'
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./draft-engine'));
  else root.MaddenSeason = factory(root.DraftEngine);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (E) {
  'use strict';

  // ---------- Team strength ----------
  // Offense scores, defense stops. Returns expected points vs a league-average
  // opponent, derived from the drafted starters.
  function teamStrength(state, poolMap, teamId) {
    const s = E.teamSummary(state, poolMap, teamId);
    const off = s.off == null ? 70 : s.off;
    const def = s.def == null ? 70 : s.def;
    return { off, def, ovr: s.starters == null ? 70 : s.starters };
  }

  // ---------- Schedule (circle method round-robin) ----------
  function roundRobinWeeks(teamIds, rng) {
    const ids = teamIds.slice();
    const odd = ids.length % 2 === 1;
    if (odd) ids.push(null); // bye
    const n = ids.length;
    const rounds = [];
    const arr = ids.slice();
    for (let r = 0; r < n - 1; r++) {
      const games = [];
      for (let i = 0; i < n / 2; i++) {
        const a = arr[i], b = arr[n - 1 - i];
        if (a && b) games.push(r % 2 === 0 ? [a, b] : [b, a]); // alternate home/away
      }
      rounds.push(games);
      arr.splice(1, 0, arr.pop()); // rotate
    }
    return rounds;
  }

  function buildSchedule(state) {
    const ids = state.teams.map(t => t.id);
    const base = roundRobinWeeks(ids);
    const perLeg = base.length;
    // Small leagues play multiple legs so everyone gets a real season;
    // big leagues are capped like a real NFL slate.
    const legs = perLeg >= 10 ? 1 : Math.min(4, Math.ceil(10 / perLeg));
    const weeks = [];
    for (let leg = 0; leg < legs && weeks.length < 17; leg++) {
      base.forEach((games, wi) => {
        if (weeks.length >= 17) return;
        weeks.push({
          n: weeks.length + 1,
          leg: leg + 1,
          games: games.map(([h, a], gi) => ({
            id: `W${weeks.length + 1}G${gi + 1}`,
            homeId: leg % 2 === 0 ? h : a, // flip home/away on even legs
            awayId: leg % 2 === 0 ? a : h,
            hs: null, as: null, played: false
          }))
        });
      });
    }
    return weeks;
  }

  // ---------- Game sim ----------
  function simScore(exp, rng) {
    const noise = ((rng() + rng() + rng()) - 1.5) / 1.5 * 8; // ~bell, +/-8
    return Math.max(0, Math.round(Math.min(55, Math.max(3, exp)) + noise));
  }

  function simGame(home, away, rng) {
    let hs = simScore(20 + (home.off - away.def) * 1.1 + 1.5, rng);
    let as = simScore(20 + (away.off - home.def) * 1.1, rng);
    let ot = false;
    if (hs === as) { // overtime: weighted coin flip, winner +3
      ot = true;
      const hp = 0.5 + (home.ovr - away.ovr) * 0.02;
      if (rng() < hp) hs += 3; else as += 3;
    }
    return { hs, as, ot };
  }

  // ---------- Season lifecycle ----------
  function createSeason(state, poolMap) {
    if (state.status !== 'complete') throw new Error('Finish the draft before simulating a season');
    const rng = E.createRng(state.seed + '|season');
    const shuffled = E.shuffle(state.teams.map(t => t.id), rng);
    // Rebuild schedule off shuffled ids for variety, then map back — simpler:
    // build from team order as-is; seed already randomizes everything else.
    const weeks = buildSchedule(state);
    return { status: 'regular', weeks, cur: 0, playoffs: null, createdAt: Date.now(), shuffled };
  }

  function ensureSeason(state, poolMap) {
    if (!state.season) state.season = createSeason(state, poolMap);
    return state.season;
  }

  function playGame(state, poolMap, game, rng) {
    const home = teamStrength(state, poolMap, game.homeId);
    const away = teamStrength(state, poolMap, game.awayId);
    const { hs, as, ot } = simGame(home, away, rng);
    game.hs = hs; game.as = as; game.ot = ot; game.played = true;
    return game;
  }

  // Standings from all played regular-season games.
  function standings(state) {
    const t = {};
    state.teams.forEach(tm => { t[tm.id] = { teamId: tm.id, name: tm.name, isBot: tm.isBot, w: 0, l: 0, tied: 0, pf: 0, pa: 0 }; });
    const season = state.season;
    if (season) {
      season.weeks.forEach(w => w.games.forEach(g => {
        if (!g.played) return;
        const h = t[g.homeId], a = t[g.awayId];
        h.pf += g.hs; h.pa += g.as; a.pf += g.as; a.pa += g.hs;
        if (g.hs > g.as) { h.w++; a.l++; }
        else if (g.as > g.hs) { a.w++; h.l++; }
        else { h.tied++; a.tied++; }
      }));
    }
    const rows = Object.values(t);
    rows.forEach(r => {
      r.gp = r.w + r.l + r.tied;
      r.diff = r.pf - r.pa;
      r.pct = r.gp ? (r.w + r.tied * 0.5) / r.gp : 0;
    });
    rows.sort((a, b) => (b.pct - a.pct) || (b.diff - a.diff) || (b.pf - a.pf));
    rows.forEach((r, i) => { r.rank = i + 1; });
    return rows;
  }

  function playoffSize(n) {
    if (n >= 8) return 8;
    if (n >= 4) return 4;
    return 2;
  }

  function startPlayoffs(state) {
    const table = standings(state);
    const size = playoffSize(table.length);
    const seeds = table.slice(0, size).map(r => r.teamId);
    const rounds = [];
    const names = { 8: ['Wild Card', 'Divisional', 'Conference', 'Championship'], 4: ['Semifinal', 'Championship'], 2: ['Championship'] }[size];
    let current = seeds;
    names.forEach((name, ri) => {
      const games = [];
      for (let i = 0; i < current.length / 2; i++) {
        const hi = current[i], lo = current[current.length - 1 - i];
        games.push({ id: `P${ri + 1}G${i + 1}`, round: name, homeId: hi, awayId: lo, hs: null, as: null, ot: false, played: false, winnerId: null });
      }
      rounds.push({ name, games });
      current = new Array(games.length).fill(null); // winners feed next round
    });
    state.season.playoffs = { size, rounds, cur: 0, champion: null };
    state.season.status = 'playoffs';
  }

  function simPlayoffRound(state, poolMap) {
    const p = state.season.playoffs;
    const round = p.rounds[p.cur];
    const rng = E.createRng(state.seed + '|season|playoff|' + p.cur);
    const winners = [];
    round.games.forEach(g => {
      const home = teamStrength(state, poolMap, g.homeId);
      const away = teamStrength(state, poolMap, g.awayId);
      // Slight favorite boost for the higher seed at home.
      const { hs, as, ot } = simGame({ off: home.off + 1, def: home.def, ovr: home.ovr }, away, rng);
      g.hs = hs; g.as = as; g.ot = ot; g.played = true;
      g.winnerId = hs > as ? g.homeId : g.awayId;
      winners.push(g.winnerId);
    });
    p.cur++;
    if (p.cur < p.rounds.length) {
      // Feed winners into the next round, 1-seed style ordering preserved.
      const next = p.rounds[p.cur];
      const ordered = [];
      for (let i = 0; i < winners.length / 2; i++) ordered.push([winners[i], winners[winners.length - 1 - i]]);
      next.games.forEach((g, i) => { g.homeId = ordered[i][0]; g.awayId = ordered[i][1]; });
    } else {
      p.champion = winners[0];
      state.season.status = 'complete';
      state.season.completedAt = Date.now();
    }
    return round.games;
  }

  // Advance one step: next regular-season week, or next playoff round.
  // Returns { kind: 'week'|'playoffs'|'done', games }
  function advance(state, poolMap) {
    const season = ensureSeason(state, poolMap);
    const rng = E.createRng(state.seed + '|season|week|' + season.cur);
    if (season.status === 'regular') {
      if (season.cur >= season.weeks.length) {
        startPlayoffs(state);
        return { kind: 'playoffs', games: [] };
      }
      const week = season.weeks[season.cur];
      week.games.forEach(g => playGame(state, poolMap, g, rng));
      season.cur++;
      if (season.cur >= season.weeks.length) startPlayoffs(state);
      return { kind: 'week', week: week.n, games: week.games };
    }
    if (season.status === 'playoffs') {
      const games = simPlayoffRound(state, poolMap);
      return { kind: 'playoff-round', games, done: season.status === 'complete' };
    }
    return { kind: 'done', games: [] };
  }

  function simAll(state, poolMap) {
    const out = [];
    for (;;) {
      const r = advance(state, poolMap);
      out.push(r);
      if (r.kind === 'done') break;
    }
    return out;
  }

  function resetSeason(state) {
    delete state.season;
  }

  // Head-to-head result between two teams this season (regular season only).
  function headToHead(state, aId, bId) {
    const games = [];
    if (state.season) {
      state.season.weeks.forEach(w => w.games.forEach(g => {
        if (!g.played) return;
        const ids = [g.homeId, g.awayId];
        if (ids.includes(aId) && ids.includes(bId)) {
          games.push({ week: w.n, homeId: g.homeId, awayId: g.awayId, hs: g.hs, as: g.as,
            winnerId: g.hs === g.as ? null : (g.hs > g.as ? g.homeId : g.awayId) });
        }
      }));
    }
    return games;
  }

  // Fun season superlatives for the recap screen.
  function superlatives(state, poolMap) {
    const table = standings(state);
    let biggest = null, shootout = null;
    if (state.season) {
      state.season.weeks.forEach(w => w.games.forEach(g => {
        if (!g.played) return;
        const margin = Math.abs(g.hs - g.as), total = g.hs + g.as;
        if (!biggest || margin > biggest.margin) biggest = { margin, hs: g.hs, as: g.as, homeId: g.homeId, awayId: g.awayId, week: w.n };
        if (!shootout || total > shootout.total) shootout = { total, hs: g.hs, as: g.as, homeId: g.homeId, awayId: g.awayId, week: w.n };
      }));
    }
    const name = id => (E.getTeam(state, id) || {}).name || id;
    return {
      bestRecord: table[0] || null,
      worstRecord: table[table.length - 1] || null,
      mostPoints: table.slice().sort((a, b) => b.pf - a.pf)[0] || null,
      bestDefense: table.slice().sort((a, b) => a.pa - b.pa)[0] || null,
      biggestBlowout: biggest && Object.assign({}, biggest, { home: name(biggest.homeId), away: name(biggest.awayId) }),
      shootout: shootout && Object.assign({}, shootout, { home: name(shootout.homeId), away: name(shootout.awayId) })
    };
  }

  return {
    teamStrength, buildSchedule, simGame,
    createSeason, ensureSeason, advance, simAll, resetSeason,
    standings, playoffSize, headToHead, superlatives
  };
});
