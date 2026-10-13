# Madden Startup Franchise Draft

A live 25-round snake draft for 2 to 32 teams. Every team builds the same 25-man roster.
Play solo against bots, pass one device around (couch mode), or run an online room with friends.

## Quick start

```bash
npm install
npm start            # http://localhost:3000
```

Friends on your network join at `http://YOUR-IP:3000` with the 5-letter room code.

No server? Run `npm run build:standalone` and open `dist/madden-draft-standalone.html`.
It runs solo and couch drafts fully in the browser.

## Roster rules (enforced on every pick)

| Unit | Slots | Count |
| --- | --- | --- |
| Offense | QB, HB, WR x3, TE x2, LT, RT, LG, RG, C | 12 |
| Defense | EDGE x2, DT x2, MLB, OLB, CB x3, FS, SS | 11 |
| Backups | 1 offense (QB/RB/WR/TE/OL), 1 defense (DL/LB/DB) | 2 |

A pick fills the matching starter slot first (an LT goes to LT if open), then any open
starter slot for that group, then the side's backup slot. If none is open, the pick is
rejected. Because 25 rounds = 25 slots, every legal pick keeps the roster completable.

## How it works

```
shared/draft-engine.js   Rules, snake order, seeded PRNG, bot brain (browser + Node)
shared/player-data.js    Built-in pool: 122 real stars + generated depth (1,380 players)
server.js                Express + Socket.io. Server is the only source of truth.
public/index.html        Single-page client (Tailwind CDN, vanilla JS)
data/sessions/*.json     One file per room, saved after every change
data/players.json        Optional custom pool (overrides the built-in one)
scripts/simulate.js      npm test: full bot drafts for 2-32 teams, checks every rule
```

- **Draft order:** shuffled from the seed (mulberry32 PRNG). Same seed, same order.
- **Snake:** odd rounds 1 to N, even rounds N to 1.
- **Bots:** five styles (balanced, best available, trenches, skill, needs-based).
  Bot picks are seeded too, so a full mock is reproducible.
- **Pick clock:** optional. When it runs out, the server auto-picks.
- **Host tools:** pause, resume, force auto-pick, undo last pick (undo also pauses).
- **Restarts:** sessions reload from `data/sessions` and the draft continues.
- **Reconnect:** the browser keeps a member token, so a refresh drops you back in your seat.

## Custom player pool

Drop a JSON array in `data/players.json` (server) or use **Load player JSON** (solo mode):

```json
[{ "name": "Josh Allen", "team": "BUF", "pos": "QB", "ovr": 96, "adp": 7 }]
```

Accepted positions: QB, HB/RB/FB, WR, TE, LT/RT/OT, LG/RG/OG, C, DE/LE/RE/EDGE,
DT/NT/IDL, MLB/ILB/OLB/LB, CB, FS/SS/S. K, P, and LS are skipped. `adp` is optional;
it is computed from rating and position if missing. The pool is checked for size before
a draft starts.

The built-in star ratings are rough approximations, not official Madden ratings, and
teams reflect the 2025 season. Depth players are fictional.

## API

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/health` | Server status |
| GET | `/api/pool` | Player pool |
| GET | `/api/sessions/:id` | Public room state |
| GET | `/api/sessions/:id/export` | Order, picks, rosters, grades (JSON download) |

Socket events (all use acknowledgements `{ ok, error? }`):
`room:create`, `room:join`, `room:leave`, `team:claim`, `team:release`, `draft:start`,
`draft:pick`, `draft:autopick`, `draft:pause`, `draft:undo`. The server broadcasts `state`.
