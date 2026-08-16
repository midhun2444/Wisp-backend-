# WISP backend

Real-time matchmaking + chat relay for WISP. This is the piece that was
missing from the frontend preview — it actually pairs two different,
currently-connected browsers together.

**What this backend does:**
- Holds a live queue of real, connected users waiting to chat
- Matches by: shared interests → gender preference (Boy/Girl/Random) → random worldwide
- Relays messages, typing indicators, and disconnect/report events between exactly two sockets
- Tells the client honestly when nobody's available, instead of ever making one up

**What this backend deliberately does *not* do:**
- It never creates a bot, script, or AI to fill an empty chat slot. If `findBestMatch`
  comes back empty, the user gets `no-match` with the message "No users are
  available to match right now. Please try again in a few moments." — see
  `src/matchmaking.js` and `enterMatchQueue()` in `server.js`.
- It doesn't verify anyone's age by itself. `src/verification.js` is the integration
  point for a real provider (Persona, Veriff, Yoti, etc) — wire your provider's
  webhook into `/webhooks/verification` and call `markUserVerified()` from there.
  Until you do that, `REQUIRE_VERIFIED_ACCOUNT=true` means **nobody** can queue,
  which is the safe default.
- It does not claim end-to-end encryption, because it doesn't have any. Messages
  are relayed through the server in plaintext, protected only by TLS in transit
  (the `wss://` connection Railway/Render provide automatically). That's "encrypted
  in transit," not E2EE — the frontend copy is worded to say exactly that and no
  more. Real E2EE would mean the server physically cannot read message content,
  which would require client-side key exchange and encryption (e.g. the Signal
  protocol) — a substantial separate feature, not something to claim without
  actually building it.

## Setup

```bash
npm install
cp .env.example .env
# edit .env — at minimum set ALLOWED_ORIGINS to your deployed frontend URL
npm start
```

`.env` is gitignored on purpose — never commit it. `.env.example` is the
template that's safe to commit; fill in your real values only in your local
`.env` or your host's environment variable settings (Render/Railway both
have an "Environment" tab for this). At minimum, set `ALLOWED_ORIGINS`. If
you want the `/admin/reports` endpoint reachable at all, also set
`ADMIN_TOKEN` to a long random string — it's disabled entirely otherwise.

Server starts on `PORT` (default 4000). Check it's alive:

```bash
curl http://localhost:4000/health
```

## Deploying

Any Node host works (Railway, Render, Fly.io, a VPS). Two things matter:

1. **WebSockets must be allowed** on whatever host/proxy you use — Socket.IO
   falls back to polling but real-time chat wants a real WS connection.
2. **Set `ALLOWED_ORIGINS`** to your actual frontend domain(s), comma-separated.
   Leaving this wide open defeats CORS protection.

## Wiring up the frontend

The WISP.jsx artifact currently *simulates* matching client-side (see the
comments above `StepSearching` and `ChatInterface` in that file). To connect
it to this real backend:

1. `npm install socket.io-client` in your frontend build.
2. On mount, connect once: `const socket = io("https://your-backend-url")`.
3. After the onboarding steps collect profile/interests/matchType, call:
   ```js
   socket.emit("register", profileData, (res) => {
     if (!res.ok) { /* show res.errors */ }
   });
   ```
4. Replace the `StepSearching` timeout simulation with:
   ```js
   socket.emit("find-match", (res) => { if (!res.ok) showError(res.error); });
   socket.once("matched", ({ roomId, partner }) => { /* go to chat screen */ });
   socket.once("no-match", () => { /* show the "no one's available" screen */ });
   ```
5. Replace the `ChatInterface` local-only send with:
   ```js
   socket.emit("send-message", { text });
   socket.on("message", ({ text, at }) => { /* append as "them" bubble */ });
   socket.on("partner-typing", (isTyping) => { /* show/hide typing dots */ });
   socket.on("partner-left", ({ reason }) => { /* show chat-ended screen */ });
   ```
6. Stop Chat → `socket.emit("stop-chat")`. Next Match → just `socket.emit("next-match", (res) => {...})`
   — the server ends the current room *and* re-enters the queue in one step; you don't need to
   also call `find-match` afterward (an earlier version of this backend required that as a
   workaround for a bug where `next-match` didn't actually re-queue anyone — that's fixed now).
   Report → `socket.emit("report-user", { reason, details })`.

## What's still needed before this is production-ready

- A real database instead of the in-memory `Map`s in `matchmaking.js`,
  `rooms.js`, and `reports.js` — right now everything resets on restart and
  won't scale past one server process.
- A real verification provider wired into `src/verification.js`.
- A moderation workflow for the reports in `src/reports.js` — right now
  they're just logged (capped at the last 2000), nobody gets banned automatically.
- If you run more than one server instance, you'll need a shared store
  (Redis) for the queue/rooms instead of in-memory `Map`s, plus Socket.IO's
  Redis adapter so rooms/matching work correctly across instances.

## What's already handled

- Per-socket rate limiting on `register`, `find-match`, `send-message`,
  `typing`, and `report-user` — see `rateLimited()` in `server.js`.
- Input validation on every field the client sends (name/age/gender/
  matchType/interests/country/state/place), with the server as the source
  of truth regardless of what the frontend already checks.
- A capped transport-level payload size (`maxHttpBufferSize`) plus a
  capped Express JSON body size, so oversized payloads are rejected early.
- `helmet` for standard HTTP security headers.
- Graceful shutdown on `SIGTERM`/`SIGINT` (Railway sends this before
  redeploying) so in-flight connections close cleanly instead of dropping.
- `GET /admin/reports` is disabled by default and only responds if you set
  `ADMIN_TOKEN`, checked against an `Authorization: Bearer <token>` header.
- `railway.json` and `Procfile` are both included so Railway's build/start
  commands are explicit rather than relying on auto-detection.
