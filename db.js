/**
 * MongoDB connection + schemas for WISP's persistent features (close
 * friends, friend requests, notifications). This is the ONLY persistent
 * storage in the app — everything else (matching queue, active rooms,
 * reports) stays in-memory by design, since it's meant to be ephemeral.
 *
 * Set MONGODB_URI in Railway's environment variables to your connection
 * string. If it's not set, everything in this file safely no-ops — the
 * rest of WISP (matching, chat, reports) keeps working exactly as before,
 * just without the friends feature. This app never pretends persistence
 * is happening when it isn't.
 */
const mongoose = require("mongoose");

let connected = false;
let connecting = null;

async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    // eslint-disable-next-line no-console
    console.warn("[wisp] MONGODB_URI not set — close friends feature disabled, everything else works normally.");
    return false;
  }
  if (connected) return true;
  if (connecting) return connecting;
  connecting = mongoose
    .connect(uri, { serverSelectionTimeoutMS: 8000 })
    .then(() => {
      connected = true;
      // eslint-disable-next-line no-console
      console.log("[wisp] MongoDB connected — close friends feature enabled.");
      return true;
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[wisp] MongoDB connection failed:", err.message);
      connected = false;
      return false;
    });
  return connecting;
}

function isDbConnected() {
  return connected;
}

/**
 * One document per returning visitor, keyed by a device ID the frontend
 * generates once and stores in localStorage (see main.jsx/App.jsx —
 * DEVICE_ID). This is how "the same person" is recognized across visits
 * without a password/login system, matching WISP's existing anonymous
 * model. Profile fields here are a light cache for notification display
 * (e.g. showing a friend's name) — the live matching profile still comes
 * from the in-memory session as before.
 */
const userSchema = new mongoose.Schema({
  deviceId: { type: String, required: true, unique: true, index: true },
  name: { type: String, default: "" },
  photoUrl: { type: String, default: "" },
  lastSeen: { type: Date, default: Date.now },
});

/**
 * A friend request or an accepted friendship, depending on `status`.
 * Kept as one collection with a status field rather than two, since a
 * request and its resulting friendship are the same relationship over
 * time — simpler to query "are these two people friends or pending?" in
 * one place.
 */
const friendLinkSchema = new mongoose.Schema({
  fromDeviceId: { type: String, required: true, index: true },
  toDeviceId: { type: String, required: true, index: true },
  status: { type: String, enum: ["pending", "accepted", "declined"], default: "pending", index: true },
  createdAt: { type: Date, default: Date.now },
  respondedAt: { type: Date, default: null },
});
friendLinkSchema.index({ fromDeviceId: 1, toDeviceId: 1 }, { unique: true });

const User = mongoose.model("User", userSchema);
const FriendLink = mongoose.model("FriendLink", friendLinkSchema);

module.exports = { connectDB, isDbConnected, User, FriendLink };
