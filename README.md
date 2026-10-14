# FRANCHISE — Multiplayer Draft & Season Sim

Start a Madden-style franchise with your friends: create a league, share an invite link, run a live 25-round snake draft, then simulate the season — full schedule, standings, playoffs, and a champion. Finish it off with side-by-side team comparisons to settle every debate.

## How it works

1. **Create a league** — pick team count (2–32), human slots, and a pick timer. You get a room code **and a shareable invite link** (`/?room=CODE`).
2. **Invite friends** — they open the link, enter a name, and claim a team. Empty seats become CPU bots with their own draft strategies.
3. **Draft** — live snake draft, 25 rounds, position filters, search, draft board, pick timer, host pause/undo.
4. **Season HQ** — sim week-by-week or the whole season at once. Weekly scores, standings, playoff bracket, superlatives, champion banner.
5. **Compare** — pick any two teams for a head-to-head breakdown: record, PF/PA, roster overalls, top players, head-to-head results.

**Solo mode** — no friends needed. Hit "Start solo draft" on the home page to draft against the CPU and sim the season entirely in your browser. Progress auto-saves to localStorage so you can resume later.

## Run locally

```bash
npm install
npm start        # http://localhost:3000
npm test         # draft + season simulations for 2/4/6/12/24/32 teams
```

## Deploy (Render)

- Build Command: `npm install`
- Start Command: `node server.js`
- The server reads `PORT` from the environment. Rooms persist to `data/sessions/`.

## Files

- `index.html` — the whole app (home, lobby, draft, season, compare)
- `server.js` — Express + Socket.IO server, live picks/season, room persistence
- `draft-engine.js` — draft rules, snake order, bots (shared browser + Node)
- `season-engine.js` — schedule, game sim, standings, playoffs (shared browser + Node)
- `player-data.js` — built-in pool: ~130 real NFL stars + generated depth (1,330 players)
- `simulate.js` — headless draft + season verification (`npm test`)

## Notes

- Player ratings are rough approximations, **not** official Madden ratings. Swap in your own pool via `data/players.json` (array of `{name, team, pos, ovr}`).
- No accounts, no tracking — a room code in `localStorage` is the only identity.
