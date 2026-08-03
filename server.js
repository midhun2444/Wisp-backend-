require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuid } = require("uuid");

const matchmaking = require("./src/matchmaking");
const rooms = require("./src/rooms");
const { fileReport, listReports } = require("./src/reports");
const {
  isVerified,
  verificationWebhookHandler,
} = require("./src/verification");

const PORT = process.env.PORT || 4000;
const HOST = "0.0.0.0"; // Railway (and most container hosts) require binding
// to all interfaces, not just localhost — "127.0.0.1" is unreachable from
// outside the container and is a common cause of "deployed but unreachable."

const MATCH_TIMEOUT_MS = Number(process.env.MATCH_TIMEOUT_MS || 25000);
const REQUIRE_VERIFIED_ACCOUNT = process.env.REQUIRE_VERIFIED_ACCOUNT !== "false";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

const NO_MATCH_MESSAGE =
  "No users are available to match right now. Please try again in a few moments.";

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:3000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (ALLOWED_ORIGINS.length === 0) {
  // Never silently lock every origin out — that just turns into a wall of
  // CORS errors with no obvious cause. Warn loudly and fail open instead.
  // eslint-disable-next-line no-console
  console.warn(
    "[wisp] ALLOWED_ORIGINS is empty — allowing all origins (*). Set ALLOWED_ORIGINS in production."
  );
  ALLOWED_ORIGINS.push("*");
}

const app = express();
app.use(helmet({
  // This API is deliberately called from a separate frontend origin
  // (ALLOWED_ORIGINS) — the default same-origin resource policy would
  // block that, so it's relaxed specifically for that case.
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json({ limit: "100kb" })); // cap body size — cheap DoS guard

// Root route — some hosts (Railway included, depending on config) health-
// check "/" by default. Without a handler here, that 404s and can get a
// deploy marked unhealthy even though the app is actually running fine.
app.get("/", (req, res) => {
  res.status(200).send("WISP backend is running.");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    queueSize: matchmaking.queueSize(),
    activeRooms: rooms.activeRoomCount(),
    onlineNow: io.engine.clientsCount,
  });
});

// Real verification provider webhook lands here — see src/verification.js
app.post("/webhooks/verification", verificationWebhookHandler);

// Admin peek at open reports — gated behind ADMIN_TOKEN. With no token set
// this route is disabled entirely rather than left open by default.
app.get("/admin/reports", (req, res) => {
  if (!ADMIN_TOKEN) {
    return res.status(404).json({ error: "not enabled" });
  }
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${ADMIN_TOKEN}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  res.json(listReports());
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS, methods: ["GET", "POST"] },
  // Caps any single socket payload at 64KB at the transport level — well
  // above anything a real chat message/profile needs, but low enough to
  // block someone trying to send an oversized payload as a DoS vector.
  // This is a second, earlier line of defense; the 2000-char message cap
  // further down still applies on top of this.
  maxHttpBufferSize: 64 * 1024,
});

// socketId -> the profile info that socket registered with
const sessions = new Map();
// socketId -> the timeout handle for their current matchmaking attempt
const matchTimeouts = new Map();
// socketId -> per-event rate-limit tracking (see rateLimited() below)
const rateLimits = new Map();

function clearMatchTimeout(socketId) {
  const t = matchTimeouts.get(socketId);
  if (t) {
    clearTimeout(t);
    matchTimeouts.delete(socketId);
  }
}

function endRoomForSocket(socketId, { notifyPartner = true, reason = "stopped" } = {}) {
  const partnerId = rooms.getPartnerSocketId(socketId);
  const room = rooms.destroyRoomForSocket(socketId);
  if (!room) return;
  if (notifyPartner && partnerId) {
    io.to(partnerId).emit("partner-left", { reason });
  }
}

function broadcastOnlineCount() {
  // Real count of currently connected sockets — not an estimate, not
  // padded. 0 means 0. This is the only source of truth the frontend
  // badge is allowed to show.
  io.emit("online-count", io.engine.clientsCount);
}

/**
 * Simple per-socket sliding-window rate limiter. Returns true if this
 * call should be BLOCKED (over the limit), false if it's allowed.
 * Memory stays bounded: old hits fall out of the window naturally, and
 * the whole entry is deleted in cleanupSocket() on disconnect.
 */
function rateLimited(socketId, key, maxEvents, windowMs) {
  const now = Date.now();
  let perSocket = rateLimits.get(socketId);
  if (!perSocket) {
    perSocket = new Map();
    rateLimits.set(socketId, perSocket);
  }
  let hits = perSocket.get(key) || [];
  hits = hits.filter((t) => now - t < windowMs);
  if (hits.length >= maxEvents) {
    perSocket.set(key, hits);
    return true;
  }
  hits.push(now);
  perSocket.set(key, hits);
  return false;
}

function cleanupSocket(socketId) {
  matchmaking.removeFromQueue(socketId);
  clearMatchTimeout(socketId);
  endRoomForSocket(socketId, { reason: "disconnected" });
  sessions.delete(socketId);
  rateLimits.delete(socketId);
}

/** Only ever share the minimum needed to render the chat header. Both
 *  sides are 18+ (age-gated at register()), so name/age/gender/country/
 *  interests here are ordinary profile info the person entered to be
 *  matched, not secretly harvested data. State/city are optional fields
 *  — only included if the person actually filled them in. Deliberately
 *  excludes anything more identifying (no exact address, no last name,
 *  no contact info). */
function publicProfile(session) {
  if (!session) {
    return { name: "Anonymous", age: null, gender: "", country: "", state: "", place: "", interests: [] };
  }
  return {
    name: session.name,
    age: session.age,
    gender: session.gender,
    country: session.country,
    state: session.state || "",
    place: session.place || "",
    interests: session.interests || [],
  };
}

/**
 * Puts `socket` into the matching queue and attempts an immediate match.
 * This is the single source of truth for "enter the queue" — both the
 * find-match event AND next-match call this directly, server-side, so
 * matching no longer silently depends on the client re-emitting anything
 * (that was the root cause of the Next Match bug — see below).
 */
function enterMatchQueue(socket, ack) {
  const me = sessions.get(socket.id);
  if (!me) {
    if (typeof ack === "function") ack({ ok: false, error: "not registered" });
    return;
  }
  if (REQUIRE_VERIFIED_ACCOUNT && !isVerified(me.userId)) {
    if (typeof ack === "function") ack({ ok: false, error: "account not verified" });
    return;
  }
  if (rooms.getRoomForSocket(socket.id)) {
    if (typeof ack === "function") ack({ ok: false, error: "already in a chat" });
    return;
  }
  if (matchmaking.isInQueue(socket.id)) {
    // Already waiting — don't duplicate the queue entry or restart the
    // clock just because a client fired the event twice.
    if (typeof ack === "function") ack({ ok: true, alreadyQueued: true });
    return;
  }

  matchmaking.addToQueue({
    socketId: socket.id,
    userId: me.userId,
    gender: me.gender,
    matchType: me.matchType,
    interests: me.interests,
    joinedAt: Date.now(),
  });

  tryResolveMatch(socket.id);

  // If not matched right away, give it MATCH_TIMEOUT_MS before telling
  // them honestly that no one's available. This backend never fills
  // that gap with a bot or a fake user.
  clearMatchTimeout(socket.id);
  const timeout = setTimeout(() => {
    if (matchmaking.isInQueue(socket.id)) {
      matchmaking.removeFromQueue(socket.id);
      io.to(socket.id).emit("no-match", { message: NO_MATCH_MESSAGE });
    }
  }, MATCH_TIMEOUT_MS);
  matchTimeouts.set(socket.id, timeout);

  if (typeof ack === "function") ack({ ok: true });
}

/**
 * Sweep the queue for a compatible pair for `socketId` and connect them
 * if found. Never invents a partner — matchmaking.findBestMatch() only
 * ever returns a real, currently-queued socket or null.
 */
function tryResolveMatch(socketId) {
  const me = sessions.get(socketId);
  if (!me || !matchmaking.isInQueue(socketId)) return;

  const entry = { socketId, userId: me.userId, gender: me.gender, matchType: me.matchType, interests: me.interests };
  const partnerEntry = matchmaking.findBestMatch(entry);
  if (!partnerEntry) return;

  matchmaking.removeFromQueue(socketId);
  matchmaking.removeFromQueue(partnerEntry.socketId);
  clearMatchTimeout(socketId);
  clearMatchTimeout(partnerEntry.socketId);

  const roomId = matchmaking.newRoomId();
  rooms.createRoom(roomId, socketId, partnerEntry.socketId);

  const partnerSession = sessions.get(partnerEntry.socketId);

  io.to(socketId).emit("matched", { roomId, partner: publicProfile(partnerSession) });
  io.to(partnerEntry.socketId).emit("matched", { roomId, partner: publicProfile(sessions.get(socketId)) });
}

io.on("connection", (socket) => {
  broadcastOnlineCount();

  // --- Register / update this socket's profile -----------------------
  // Called once right after connect, with whatever the onboarding step
  // collected client-side. Every field is validated here — never trust
  // the client, even though the frontend also validates.
  socket.on("register", (profile, ack) => {
    try {
      if (rateLimited(socket.id, "register", 5, 10_000)) {
        if (typeof ack === "function") ack({ ok: false, error: "too many attempts, slow down" });
        return;
      }

      const errors = [];
      if (!profile || typeof profile !== "object") {
        errors.push("missing profile");
      } else {
        if (!profile.name || typeof profile.name !== "string" || !profile.name.trim()) {
          errors.push("name required");
        } else if (profile.name.trim().length > 40) {
          errors.push("name too long");
        }
        if (!profile.gender || typeof profile.gender !== "string") errors.push("gender required");
        if (!profile.age || Number.isNaN(Number(profile.age)) || Number(profile.age) < 18) {
          errors.push("must be 18 or older");
        }
        if (!["boy", "girl", "random"].includes(profile.matchType)) errors.push("invalid matchType");
        if (profile.interests && !Array.isArray(profile.interests)) errors.push("interests must be a list");
        if (Array.isArray(profile.interests) && profile.interests.length > 20) {
          errors.push("too many interests");
        }
        if (profile.country && String(profile.country).length > 60) errors.push("country too long");
        if (profile.state && String(profile.state).length > 60) errors.push("state too long");
        if (profile.place && String(profile.place).length > 60) errors.push("place too long");
      }
      if (errors.length) {
        if (typeof ack === "function") ack({ ok: false, errors });
        return;
      }

      const userId = profile.userId || uuid();
      sessions.set(socket.id, {
        userId,
        name: profile.name.trim().slice(0, 40),
        age: Number(profile.age),
        gender: profile.gender,
        country: (profile.country || "").slice(0, 60),
        state: (profile.state || "").slice(0, 60),
        place: (profile.place || "").slice(0, 60),
        interests: Array.isArray(profile.interests) ? profile.interests.slice(0, 20) : [],
        matchType: profile.matchType,
      });

      if (typeof ack === "function") {
        ack({
          ok: true,
          userId,
          verified: isVerified(userId),
          verificationRequired: REQUIRE_VERIFIED_ACCOUNT,
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[wisp] register handler error:", err);
      if (typeof ack === "function") ack({ ok: false, error: "server error" });
    }
  });

  // --- Enter the matching queue ---------------------------------------
  socket.on("find-match", (ack) => {
    try {
      if (rateLimited(socket.id, "find-match", 8, 10_000)) {
        if (typeof ack === "function") ack({ ok: false, error: "too many attempts, slow down" });
        return;
      }
      enterMatchQueue(socket, ack);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[wisp] find-match handler error:", err);
      if (typeof ack === "function") ack({ ok: false, error: "server error" });
    }
  });

  socket.on("cancel-find-match", () => {
    try {
      matchmaking.removeFromQueue(socket.id);
      clearMatchTimeout(socket.id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[wisp] cancel-find-match handler error:", err);
    }
  });

  // --- Chat relay -------------------------------------------------------
  socket.on("send-message", (payload) => {
    try {
      if (rateLimited(socket.id, "send-message", 15, 5_000)) return; // silently drop spam bursts
      const partnerId = rooms.getPartnerSocketId(socket.id);
      if (!partnerId) return;
      const text = String(payload && payload.text ? payload.text : "").slice(0, 2000);
      if (!text.trim()) return;
      io.to(partnerId).emit("message", { text, at: Date.now() });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[wisp] send-message handler error:", err);
    }
  });

  socket.on("typing", (isTyping) => {
    try {
      if (rateLimited(socket.id, "typing", 20, 5_000)) return;
      const partnerId = rooms.getPartnerSocketId(socket.id);
      if (!partnerId) return;
      io.to(partnerId).emit("partner-typing", !!isTyping);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[wisp] typing handler error:", err);
    }
  });

  // --- Stop / next --------------------------------------------------------
  socket.on("stop-chat", (ack) => {
    try {
      endRoomForSocket(socket.id, { reason: "stopped" });
      if (typeof ack === "function") ack({ ok: true });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[wisp] stop-chat handler error:", err);
    }
  });

  socket.on("next-match", (ack) => {
    try {
      // Bug fix: this used to end with socket.emit("find-match"), which
      // sends an event TO the client rather than triggering the server's
      // own find-match logic — it silently did nothing. The frontend
      // happened to also call find-match itself afterward, which masked
      // it, but the server-side re-queue never actually ran. Now it
      // re-queues directly and doesn't depend on the client at all.
      endRoomForSocket(socket.id, { reason: "next" });
      enterMatchQueue(socket, ack);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[wisp] next-match handler error:", err);
      if (typeof ack === "function") ack({ ok: false, error: "server error" });
    }
  });

  // --- Reporting --------------------------------------------------------
  socket.on("report-user", (payload, ack) => {
    try {
      if (rateLimited(socket.id, "report-user", 5, 60_000)) {
        if (typeof ack === "function") ack({ ok: false, error: "too many reports, slow down" });
        return;
      }
      const me = sessions.get(socket.id);
      const partnerId = rooms.getPartnerSocketId(socket.id);
      const partner = partnerId ? sessions.get(partnerId) : null;
      const room = rooms.getRoomForSocket(socket.id);
      const report = fileReport({
        reporterId: me ? me.userId : socket.id,
        reportedId: partner ? partner.userId : partnerId || "unknown",
        roomId: room ? room.roomId : null,
        reason: String((payload && payload.reason) || "unspecified").slice(0, 100),
        details: String((payload && payload.details) || "").slice(0, 1000),
      });
      if (typeof ack === "function") ack({ ok: true, reportId: report.id });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[wisp] report-user handler error:", err);
      if (typeof ack === "function") ack({ ok: false, error: "server error" });
    }
  });

  // --- Cleanup ------------------------------------------------------------
  socket.on("disconnect", () => {
    try {
      cleanupSocket(socket.id);
      // Broadcast after the disconnecting socket is actually gone from
      // the engine's client count (next tick keeps the count accurate).
      setImmediate(broadcastOnlineCount);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[wisp] disconnect handler error:", err);
    }
  });

  socket.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error(`[wisp] socket error (${socket.id}):`, err);
  });
});

io.engine.on("connection_error", (err) => {
  // eslint-disable-next-line no-console
  console.error("[wisp] engine connection error:", err.code, err.message);
});

// --- Process-level safety nets ---------------------------------------------
// An uncaught error anywhere would otherwise crash the whole process and
// disconnect every single connected user at once. Log it and keep running.
process.on("uncaughtException", (err) => {
  // eslint-disable-next-line no-console
  console.error("[wisp] uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
  // eslint-disable-next-line no-console
  console.error("[wisp] unhandled rejection:", reason);
});

// --- Graceful shutdown -------------------------------------------------
// Railway (and most hosts) send SIGTERM before stopping/redeploying a
// container. Without handling it, in-flight connections get cut abruptly
// instead of closing cleanly.
function shutdown(signal) {
  // eslint-disable-next-line no-console
  console.log(`[wisp] received ${signal}, shutting down gracefully…`);
  io.close(() => {
    server.close(() => {
      // eslint-disable-next-line no-console
      console.log("[wisp] shut down cleanly");
      process.exit(0);
    });
  });
  // Force-exit if graceful shutdown hangs for any reason.
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`WISP backend listening on ${HOST}:${PORT}`);
});
