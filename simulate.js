// Runs full all-bot drafts + season sims for several league sizes and checks
// every roster rule, schedule invariant, and playoff outcome.
const E = require('./draft-engine');
const S = require('./season-engine');
const PD = require('./player-data');

const pool = PD.buildPool();
const map = E.indexPool(pool);
const check = E.validatePool(pool, 32);
if (!check.ok) throw new Error(check.problems.join('; '));

for (const n of [2, 4, 6, 12, 24, 32]) {
  // ---- draft ----
  const s = E.createSession({ numTeams: n, humanSlots: 0, seed: 'SIM-' + n });
  E.startDraft(s);
  while (s.status === 'drafting') {
    const oc = E.onClock(s);
    const id = E.botChoose(s, pool, map, oc.teamId);
    if (!id) throw new Error(`Stuck at pick ${s.currentPick + 1}`);
    E.makePick(s, map, id, { by: 'bot' });
  }
  for (const t of s.teams) {
    E.SLOTS.forEach((slot, i) => {
      const p = map[t.slots[i]];
      if (!p) throw new Error(`${t.name} left ${slot.key} empty`);
      if (slot.accepts.indexOf(p.pos) < 0) throw new Error(`${t.name} has a ${p.pos} in ${slot.key}`);
    });
  }
  for (let r = 0; r < E.ROUNDS; r++) {
    const ids = s.picks.slice(r * n, r * n + n).map(p => p.teamId);
    const expect = r % 2 === 0 ? s.order : s.order.slice().reverse();
    if (ids.join() !== expect.join()) throw new Error('Snake order broken in round ' + (r + 1));
  }

  // ---- season ----
  S.simAll(s, map);
  const season = s.season;
  if (!season || season.status !== 'complete') throw new Error('Season did not complete');
  if (!season.playoffs.champion) throw new Error('No champion crowned');
  const table = S.standings(s);
  if (table.length !== n) throw new Error('Standings missing teams');
  // every team played the same number of games
  const gps = new Set(table.map(r => r.gp));
  if (gps.size !== 1) throw new Error('Uneven games played: ' + [...gps].join(','));
  // wins + losses + ties balance across the league
  const tot = table.reduce((a, r) => ({ w: a.w + r.w, l: a.l + r.l, t: a.t + r.tied }), { w: 0, l: 0, t: 0 });
  if (tot.w !== tot.l) throw new Error(`W/L imbalance: ${tot.w}W / ${tot.l}L`);
  // points for == points against league-wide
  const pf = table.reduce((a, r) => a + r.pf, 0), pa = table.reduce((a, r) => a + r.pa, 0);
  if (pf !== pa) throw new Error(`PF/PA imbalance: ${pf} / ${pa}`);
  // playoff bracket integrity
  const p = season.playoffs;
  const expectSize = n >= 8 ? 8 : n >= 4 ? 4 : 2;
  if (p.size !== expectSize) throw new Error(`Playoff size ${p.size}, expected ${expectSize}`);
  p.rounds.forEach((rd, i) => {
    rd.games.forEach(g => {
      if (!g.played || !g.winnerId) throw new Error('Unplayed playoff game');
      if (i < p.rounds.length - 1) {
        const played = g.hs !== g.as || g.ot; // OT guarantees a winner
        if (!played && g.hs === g.as) throw new Error('Tied playoff game with no OT');
      }
    });
  });
  // determinism: re-sim with same seed, expect identical champion + week 1 scores
  const s2 = E.createSession({ numTeams: n, humanSlots: 0, seed: 'SIM-' + n });
  E.startDraft(s2);
  while (s2.status === 'drafting') {
    const oc = E.onClock(s2);
    E.makePick(s2, map, E.botChoose(s2, pool, map, oc.teamId), { by: 'bot' });
  }
  S.simAll(s2, map);
  const w1a = season.weeks[0].games.map(g => g.hs + '-' + g.as).join();
  const w1b = s2.season.weeks[0].games.map(g => g.hs + '-' + g.as).join();
  if (w1a !== w1b || season.playoffs.champion !== s2.season.playoffs.champion) {
    throw new Error('Season sim is not deterministic for ' + n + ' teams');
  }

  const champ = E.getTeam(s, season.playoffs.champion);
  const top = table[0];
  console.log(`${n} teams: ${s.picks.length} picks, ${season.weeks.length} weeks, champion ${champ.name} ` +
    `(best record: ${top.name} ${top.w}-${top.l}${top.tied ? '-' + top.tied : ''}). All checks passed.`);
}
console.log('All draft + season simulations passed.');
