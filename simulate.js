// Runs full all-bot drafts for several league sizes and checks every roster rule.
const E = require('../shared/draft-engine');
const PD = require('../shared/player-data');
const pool = PD.buildPool();
const map = E.indexPool(pool);
const check = E.validatePool(pool, 32);
if (!check.ok) throw new Error(check.problems.join('; '));
for (const n of [2, 6, 12, 24, 32]) {
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
  const top = E.leagueTable(s, map)[0];
  console.log(`${n} teams: ${s.picks.length} picks, all rosters legal. Best: ${top.name} (${top.starters})`);
}
console.log('All simulations passed.');
