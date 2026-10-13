# Madden Startup Franchise Draft (flat layout)

All files sit in one folder, so you can upload them to GitHub without folders.

Run locally: `npm install` then `npm start`, and open http://localhost:3000.
Deploy on Render: Build Command `npm install`, Start Command `node server.js`.

Files:
- server.js: Express + Socket.io server (live picks, saves rooms to data/sessions)
- LIVE-ROOM-SPEC.md: how live rooms work (passcodes, per-pick sync, host tools, room expiry)
- draft-engine.js: draft rules, snake order, bots
- player-data.js: built-in player pool
- index.html: the app
