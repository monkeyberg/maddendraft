# Live Room: Real-Time Drafts with Friends — Feature Spec

## 1. Feature overview

**Baseline (already shipped).** `server.js` already runs live rooms over Socket.io:

- `room:create` / `room:join` with 5-character codes
- `team:claim`
- server-side picks, the pick clock and bots
- a session saved to `data/sessions/<ROOM>.json`

The client also supports `?room=CODE` invite links and reconnects with a token stored in `localStorage`.

**This spec adds what is still missing:**

- **Low latency:** each pick sends a small delta instead of the whole `state` (up to 800 picks and 32 rosters).
- **Privacy and security:** optional room passcode, member cap, rate limits on joins, a host who can remove members, tokens stored hashed on disk, and a private `GET /api/sessions/:id`.
- **Room lifecycle:** the host role passes to someone else, and idle rooms expire.

**Unchanged:**

- `draft-engine.js` (rules, snake order, bots) and the engine's `state` schema (`version: 1`).
- Solo and couch mode.
- Dependencies: Express and Socket.io only. No new services.

## 2. User flow

1. **Host:** Online tab → Create room (teams, human slots, timer, optional passcode) → gets a code and an invite link → lands in the lobby as `T1`.
2. **Friend:** opens the invite link or enters the code → enters a name (and the passcode if one is set) → joins as a spectator → claims an open team.
3. **Lobby:** everyone sees who is online and which teams are claimed. The host can remove a member or hand the host role to someone else, then presses Start.
4. **Draft:**
   - The team on the clock submits a pick. The server checks it with `E.makePick` and sends `draft:picked` to the room.
   - Each client applies the pick to its own copy of the state with the same engine.
   - If the bot or the timer picks, the same event goes out.
5. **Disconnect:** the client rejoins with its saved token, sending the last `rev` it saw. The server sends only the missed picks, or the full state if the client fell too far behind.
6. **Complete:** results and export work as they do today.

## 3. API

### HTTP

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/sessions/:id` | Header `X-Room-Token` | `200 {state, members, deadline, serverNow, rev}` · `403` · `404` |
| GET | `/api/sessions/:id/export` | unchanged | export JSON |

### Socket events (client → server, every event gets an ack)

| Event | Payload | Ack |
|---|---|---|
| `room:create` | `{name, numTeams, humanSlots, pickTimer, botDelayMs, seed?, passcode?}` | `{ok, roomId, token, memberId, rev, view}` |
| `room:join` | `{roomId, name?, token?, passcode?, lastRev?, proto?: 2}` | `{ok, roomId, token, memberId, rev, view?, missed?: Pick[]}` or `{ok:false, error}` |
| `room:sync` | `{}` | `{ok, rev, view}` |
| `member:kick` *(host)* | `{memberId}` | `{ok}` |
| `host:transfer` *(host)* | `{memberId}` | `{ok}` |
| `team:claim`, `team:release`, `draft:start`, `draft:pick`, `draft:autopick`, `draft:pause`, `draft:undo` | unchanged | unchanged, plus `rev` |

### Socket events (server → room)

| Event | Payload |
|---|---|
| `state` | `{state, members, deadline, serverNow, rev}`. Sent on lobby, pause and undo changes, and for every change to clients that did not send `proto: 2`. |
| `draft:picked` | `{rev, pick, deadline, serverNow, status}` |
| `presence` | `{rev, members}` (no draft state) |
| `room:kicked` | `{}` (sent to the removed socket, which is then disconnected) |

## 4. Data model extensions

These changes go in the session file (`data/sessions/<ROOM>.json`), next to `state`. The engine state does not change.

```js
{
  state,                        // unchanged engine state, version 1
  members: { [sha256(token)]: { memberId, name, teamId, isHost, joinedAt } },
  room: {
    rev: 0,                     // goes up by 1 on every change the room sees
    passHash: null,             // "scrypt$salt$hash" (node:crypto), or null if no passcode
    maxMembers: 64,
    lastActiveAt: 1700000000000 // used for expiry (14 days idle)
  }
}
```

- **Loading old files:** if `room` is missing, use the defaults above. Member keys that look like a UUID (raw token) are rehashed once.
- **In memory only:** `pickLog`, the last 50 `{rev, pick}`, kept for reconnect replay.
- **Rate limits:** a per-IP counter allows at most 10 failed joins per minute.

## 5. Pseudocode

### Create a room

```text
on room:create(opts):
  rateLimit(socket.ip) or fail
  state = E.createSession(...)              # existing call
  E.claimTeam(state, 'T1', name)
  token = randomUUID()
  sess.members[sha256(token)] = {memberId, name, teamId:'T1', isHost:true}
  sess.room = {rev:0, passHash: opts.passcode ? scrypt(opts.passcode) : null, maxMembers:64, lastActiveAt:now}
  attach(socket, sess, token); commit(sess, 'state')
  ack {ok, roomId, token, memberId, rev}   # the raw token is never written to disk
```

### Join a room

```text
on room:join({roomId, token, name, passcode, lastRev, proto}):
  sess = sessions.get(roomId) or failJoin('No room with that code')
  key = token && sha256(token)
  if key not in sess.members:                       # new member
    if sess.room.passHash and not scryptVerify(passcode): failJoin('Wrong passcode')
    if size(sess.members) >= sess.room.maxMembers:    fail('Room is full')
    token = randomUUID(); key = sha256(token)
    sess.members[key] = {memberId, name, teamId:null, isHost:false}
  socket.data.proto = proto
  attach(socket, sess, token)
  missed = sess.pickLog.filter(e => e.rev > lastRev)
  if lastRev given and missed covers every rev from lastRev+1 to sess.room.rev:
    ack {ok, token, rev, missed}
  else:
    ack {ok, token, rev, view: publicView(sess)}
  emit presence

failJoin(msg): count the failure for socket.ip; ack {ok:false, error: msg}
```

### Real-time draft sync

```text
server, on draft:pick / autoPick:
  pick = E.makePick(sess.state, POOL_MAP, playerId, meta)    # unchanged rules
  commit(sess, 'pick', pick)

commit(sess, kind, pick?):
  sess.room.rev++; sess.room.lastActiveAt = now
  save(sess)              # synchronous atomic write, same as today, before anything is sent
  schedule(sess)          # sets the deadline
  if kind == 'pick':
    msg = {rev, pick, deadline, serverNow, status}
    sess.pickLog.push({rev, pick}); trim to 50
    emit msg to room sockets with proto 2; emit 'state' to the rest
  else:
    emit 'state' to room

client, on draft:picked(msg):
  if msg.rev != app.rev + 1: return requestSync()      # missed an event
  E.makePick(app.state, poolMap, msg.pick.playerId,
             {teamId: msg.pick.teamId, by: msg.pick.by, force: true})
  overwrite the new last pick with msg.pick           # keep the server's ts and slot
  if app.state.currentPick != msg.pick.overall: return requestSync()
  app.rev = msg.rev; app.deadline = msg.deadline; render the changed rows only

requestSync(): emit room:sync → replace app.state and app.rev with the result
```

### Removing members and handing over the host role

```text
on member:kick({memberId}) / host:transfer({memberId}):
  require caller.isHost
  kick: release that member's team if the room is still in the lobby,
        delete the member, emit room:kicked to their sockets, disconnect them
  transfer: caller.isHost = false; target.isHost = true
  commit(sess, 'state')

hourly: delete rooms whose lastActiveAt is more than 14 days old
        (both the in-memory session and its file)
```

## Constraint check

- **Core gameplay:** every pick still goes through `E.makePick`. Clients run the same engine and the server stays the only source of truth.
- **No new services:** uses Socket.io, Express and `node:crypto` only.
- **Latency:** a pick delta is about 200 bytes, instead of a full state that can exceed 100 KB in a 32-team draft. A gap in `rev` triggers a full resync.
- **Privacy:**
  - Raw tokens are never written to disk.
  - Members see each other only by `memberId`.
  - The passcode is stored as an scrypt hash.
  - Failed joins are rate-limited.
  - Reading a room over HTTP requires that room's token.
- **Backward compatibility:**
  - Solo mode is untouched.
  - `state.version` stays 1.
  - Old session files load with defaults.
  - Clients that do not send `proto: 2` still get full `state` broadcasts.
