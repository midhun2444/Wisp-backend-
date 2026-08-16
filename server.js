require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuid } = require("uuid");

const matchmaking = require("./matchmaking");
const rooms = require("./rooms");
const { fileReport, listReports } = require("./reports");
const { connectDB } = require("./db");
const friends = require("./friends");
const {
  isVerified,
  verificationWebhookHandler,
} = require("./verification");

const PORT = process.env.PORT || 4000;
const HOST = "0.0.0.0"; // Railway (and most container hosts) require binding
// to all interfaces, not just localhost — "127.0.0.1" is unreachable from
// outside the container and is a common cause of "deployed but unreachable."

const MATCH_TIMEOUT_MS = Number(process.env.MATCH_TIMEOUT_MS || 25000);
const REQUIRE_VERIFIED_ACCOUNT = process.env.REQUIRE_VERIFIED_ACCOUNT !== "false";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

const NO_MATCH_MESSAGE =
  "No users are available to match right now. Please try again in a few moments.";

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://wisp-frontend-chi.vercel.app")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Local dev convenience only — never adds localhost when actually deployed
// (NODE_ENV=production on Railway), so production CORS stays exact-origin-only.
if (process.env.NODE_ENV !== "production") {
  ["http://localhost:5173", "http://127.0.0.1:5173"].forEach((o) => {
    if (!ALLOWED_ORIGINS.includes(o)) ALLOWED_ORIGINS.push(o);
  });
}

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
  // Raised from 64KB to fit a compressed profile-photo thumbnail (the
  // frontend resizes/compresses photos to well under this before sending —
  // see the photo picker in StepProfile). Still far below anything close to
  // a real memory-exhaustion risk; register() also independently caps and
  // validates the photoUrl string server-side regardless of transport size.
  maxHttpBufferSize: 300 * 1024,
});

// socketId -> the profile info that socket registered with
const sessions = new Map();
// deviceId -> socketId, for friend-request notifications and starting a
// direct chat with a friend who's currently online. Populated by the
// "identify" event (sent once on connect, separate from "register" —
// identify only needs a stable deviceId, not a full matching profile).
const deviceToSocket = new Map();
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
    return { name: "Anonymous", age: null, gender: "", country: "", state: "", place: "", interests: [], photoUrl: "", deviceId: "" };
  }
  return {
    name: session.name,
    age: session.age,
    gender: session.gender,
    country: session.country,
    state: session.state || "",
    place: session.place || "",
    interests: session.interests || [],
    photoUrl: session.photoUrl || "",
    // Lets a matched partner send a close-friend request. Only populated
    // once "identify" has run for this socket — see deviceToSocket below.
    deviceId: session.deviceId || "",
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

  // Set by "identify" (see the close-friends section below), read here by
  // "register" so a session created after identify still carries its
  // deviceId — needed so a matched partner can send a friend request.
  let myDeviceId = null;

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
        } else if (!/^[1-9][0-9]{0,2}$/.test(String(profile.age)) || Number(profile.age) > 100) {
          // Rejects malformed values a naive Number() check would accept —
          // e.g. "07362" numerically passes ">= 18" but is garbage, not a
          // real age. Never rely on the frontend alone for this.
          errors.push("invalid age");
        }
        if (!["boy", "girl", "random"].includes(profile.matchType)) errors.push("invalid matchType");
        if (profile.interests && !Array.isArray(profile.interests)) errors.push("interests must be a list");
        if (Array.isArray(profile.interests) && profile.interests.length > 20) {
          errors.push("too many interests");
        }
        if (profile.country && String(profile.country).length > 60) errors.push("country too long");
        if (profile.state && String(profile.state).length > 60) errors.push("state too long");
        if (profile.place && String(profile.place).length > 60) errors.push("place too long");
        // Photo is optional. Validated but never required — a bad/oversized
        // value just gets dropped below rather than failing registration.
        if (profile.photoUrl && typeof profile.photoUrl !== "string") {
          errors.push("invalid photo");
        }
      }
      if (errors.length) {
        if (typeof ack === "function") ack({ ok: false, errors });
        return;
      }

      const userId = profile.userId || uuid();
      // Only accept a well-formed, size-capped image data URL. Anything
      // else (wrong prefix, too large, not a string) is silently dropped —
      // photo is a nice-to-have, never something that should block or
      // break registration.
      const PHOTO_MAX_CHARS = 280_000; // ~205KB raw, comfortably under maxHttpBufferSize
      let photoUrl = "";
      if (
        typeof profile.photoUrl === "string" &&
        profile.photoUrl.length > 0 &&
        profile.photoUrl.length <= PHOTO_MAX_CHARS &&
        /^data:image\/(png|jpe?g|webp);base64,/.test(profile.photoUrl)
      ) {
        photoUrl = profile.photoUrl;
      }
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
        photoUrl,
        deviceId: myDeviceId || "",
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
      // This used to also auto re-enter the matching queue here. The
      // frontend now shows a "want to edit your profile before your next
      // chat?" prompt right after a skip, so it must control exactly when
      // the new search begins (it calls find-match itself once the person
      // is past that prompt) — auto-requeueing here would put them back
      // in line with stale profile data while they're still deciding.
      endRoomForSocket(socket.id, { reason: "next" });
      if (typeof ack === "function") ack({ ok: true });
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

  // --- Close friends (requires MONGODB_URI — safely no-ops otherwise) -----

  // Sent once on connect with a stable deviceId the frontend generates and
  // stores locally. Separate from "register": identify only needs enough
  // to recognize returning visitors and route friend notifications — not
  // a full matching profile, and it doesn't require age verification since
  // it puts nobody in the matching queue.
  socket.on("identify", async (payload, ack) => {
    try {
      const deviceId = payload && typeof payload.deviceId === "string" ? payload.deviceId.slice(0, 100) : null;
      if (!deviceId) {
        if (typeof ack === "function") ack({ ok: false, error: "missing deviceId" });
        return;
      }
      myDeviceId = deviceId;
      deviceToSocket.set(deviceId, socket.id);
      const existingSession = sessions.get(socket.id);
      if (existingSession) existingSession.deviceId = deviceId;
      await friends.upsertUser(deviceId, {
        name: payload.name ? String(payload.name).slice(0, 40) : undefined,
        photoUrl: typeof payload.photoUrl === "string" ? payload.photoUrl : undefined,
      });
      if (typeof ack === "function") ack({ ok: true });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[wisp] identify handler error:", err);
      if (typeof ack === "function") ack({ ok: false, error: "server error" });
    }
  });

  socket.on("friend-request", async (payload, ack) => {
    try {
      if (!myDeviceId) {
        if (typeof ack === "function") ack({ ok: false, error: "not identified" });
        return;
      }
      if (rateLimited(socket.id, "friend-request", 15, 60_000)) {
        if (typeof ack === "function") ack({ ok: false, error: "too many requests, slow down" });
        return;
      }
      const toDeviceId = payload && typeof payload.toDeviceId === "string" ? payload.toDeviceId.slice(0, 100) : null;
      if (!toDeviceId) {
        if (typeof ack === "function") ack({ ok: false, error: "missing toDeviceId" });
        return;
      }
      const result = await friends.sendFriendRequest(myDeviceId, toDeviceId);
      // If they're online right now, notify them immediately rather than
      // making them wait until they next open their notifications.
      const theirSocketId = deviceToSocket.get(toDeviceId);
      if (theirSocketId && result.ok && result.status === "pending") {
        const me = sessions.get(socket.id);
        io.to(theirSocketId).emit("friend-request-received", {
          fromDeviceId: myDeviceId,
          name: me ? me.name : "Someone",
        });
      }
      if (typeof ack === "function") ack(result);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[wisp] friend-request handler error:", err);
      if (typeof ack === "function") ack({ ok: false, error: "server error" });
    }
  });

  socket.on("friend-respond", async (payload, ack) => {
    try {
      if (!myDeviceId) {
        if (typeof ack === "function") ack({ ok: false, error: "not identified" });
        return;
      }
      const fromDeviceId = payload && typeof payload.fromDeviceId === "string" ? payload.fromDeviceId.slice(0, 100) : null;
      const accept = !!(payload && payload.accept);
      if (!fromDeviceId) {
        if (typeof ack === "function") ack({ ok: false, error: "missing fromDeviceId" });
        return;
      }
      const result = await friends.respondToRequest(myDeviceId, fromDeviceId, accept);
      // Let the requester know if they're online, so both sides see the
      // 💞 status update without needing to manually refresh.
      const theirSocketId = deviceToSocket.get(fromDeviceId);
      if (theirSocketId && result.ok) {
        io.to(theirSocketId).emit("friend-request-answered", { byDeviceId: myDeviceId, accepted: accept });
      }
      if (typeof ack === "function") ack(result);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[wisp] friend-respond handler error:", err);
      if (typeof ack === "function") ack({ ok: false, error: "server error" });
    }
  });

  socket.on("friend-list", async (payload, ack) => {
    try {
      if (!myDeviceId) {
        if (typeof ack === "function") ack({ ok: false, error: "not identified" });
        return;
      }
      const [friendsList, incoming] = await Promise.all([
        friends.listFriends(myDeviceId),
        friends.listIncomingRequests(myDeviceId),
      ]);
      const online = friendsList.map((f) => ({ ...f, online: deviceToSocket.has(f.deviceId) }));
      if (typeof ack === "function") ack({ ok: true, friends: online, incoming });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[wisp] friend-list handler error:", err);
      if (typeof ack === "function") ack({ ok: false, error: "server error" });
    }
  });

  // Starts a direct chat with an accepted friend, bypassing the random
  // matching queue entirely. Only works if the friend is currently online.
  socket.on("friend-chat-start", async (payload, ack) => {
    try {
      if (!myDeviceId) {
        if (typeof ack === "function") ack({ ok: false, error: "not identified" });
        return;
      }
      const friendDeviceId = payload && typeof payload.friendDeviceId === "string" ? payload.friendDeviceId.slice(0, 100) : null;
      if (!friendDeviceId) {
        if (typeof ack === "function") ack({ ok: false, error: "missing friendDeviceId" });
        return;
      }
      const myFriends = await friends.listFriends(myDeviceId);
      if (!myFriends.some((f) => f.deviceId === friendDeviceId)) {
        if (typeof ack === "function") ack({ ok: false, error: "not friends with that person" });
        return;
      }
      const friendSocketId = deviceToSocket.get(friendDeviceId);
      if (!friendSocketId) {
        if (typeof ack === "function") ack({ ok: false, error: "friend is offline right now" });
        return;
      }
      if (rooms.getRoomForSocket(socket.id) || rooms.getRoomForSocket(friendSocketId)) {
        if (typeof ack === "function") ack({ ok: false, error: "one of you is already in a chat" });
        return;
      }
      const roomId = uuid();
      rooms.createRoom(roomId, socket.id, friendSocketId);
      const me = sessions.get(socket.id) || { name: "Friend" };
      const them = sessions.get(friendSocketId) || { name: "Friend" };
      io.to(socket.id).emit("matched", { roomId, partner: publicProfile(them), isFriendChat: true });
      io.to(friendSocketId).emit("matched", { roomId, partner: publicProfile(me), isFriendChat: true });
      if (typeof ack === "function") ack({ ok: true, roomId });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[wisp] friend-chat-start handler error:", err);
      if (typeof ack === "function") ack({ ok: false, error: "server error" });
    }
  });

  // --- Cleanup ------------------------------------------------------------
  socket.on("disconnect", () => {
    try {
      if (myDeviceId && deviceToSocket.get(myDeviceId) === socket.id) {
        deviceToSocket.delete(myDeviceId);
      }
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
  // Fire-and-forget: matching/chat/reports work fully without a DB
  // connection. Only the close-friends feature depends on this.
  connectDB();
});
