const { User, FriendLink, isDbConnected } = require("./db");

/** Keeps a lightweight cached profile (name/photo) for notification display. */
async function upsertUser(deviceId, { name, photoUrl } = {}) {
  if (!isDbConnected()) return null;
  const update = { lastSeen: new Date() };
  if (name) update.name = name;
  if (photoUrl) update.photoUrl = photoUrl;
  return User.findOneAndUpdate(
    { deviceId },
    { $set: update, $setOnInsert: { deviceId } },
    { upsert: true, new: true }
  );
}

async function sendFriendRequest(fromDeviceId, toDeviceId) {
  if (!isDbConnected()) return { ok: false, error: "friends feature unavailable" };
  if (fromDeviceId === toDeviceId) return { ok: false, error: "can't friend yourself" };

  // If they already sent us one, accept it instead of creating a mirror
  // request — avoids two one-directional "pending" rows for one friendship.
  const reverseExisting = await FriendLink.findOne({ fromDeviceId: toDeviceId, toDeviceId: fromDeviceId });
  if (reverseExisting && reverseExisting.status === "pending") {
    reverseExisting.status = "accepted";
    reverseExisting.respondedAt = new Date();
    await reverseExisting.save();
    return { ok: true, status: "accepted" };
  }
  if (reverseExisting && reverseExisting.status === "accepted") {
    return { ok: true, status: "accepted" };
  }

  const existing = await FriendLink.findOne({ fromDeviceId, toDeviceId });
  if (existing) {
    if (existing.status === "declined") {
      existing.status = "pending";
      existing.createdAt = new Date();
      existing.respondedAt = null;
      await existing.save();
      return { ok: true, status: "pending" };
    }
    return { ok: true, status: existing.status };
  }

  await FriendLink.create({ fromDeviceId, toDeviceId, status: "pending" });
  return { ok: true, status: "pending" };
}

async function respondToRequest(toDeviceId, fromDeviceId, accept) {
  if (!isDbConnected()) return { ok: false, error: "friends feature unavailable" };
  const link = await FriendLink.findOne({ fromDeviceId, toDeviceId, status: "pending" });
  if (!link) return { ok: false, error: "request not found" };
  link.status = accept ? "accepted" : "declined";
  link.respondedAt = new Date();
  await link.save();
  return { ok: true, status: link.status };
}

/** Pending requests THIS device has received (needs their response). */
async function listIncomingRequests(deviceId) {
  if (!isDbConnected()) return [];
  const links = await FriendLink.find({ toDeviceId: deviceId, status: "pending" }).sort({ createdAt: -1 }).lean();
  const fromIds = links.map((l) => l.fromDeviceId);
  const users = await User.find({ deviceId: { $in: fromIds } }).lean();
  const byId = Object.fromEntries(users.map((u) => [u.deviceId, u]));
  return links.map((l) => ({
    fromDeviceId: l.fromDeviceId,
    name: byId[l.fromDeviceId]?.name || "Someone",
    photoUrl: byId[l.fromDeviceId]?.photoUrl || "",
    createdAt: l.createdAt,
  }));
}

/** Accepted friends for this device, either direction. */
async function listFriends(deviceId) {
  if (!isDbConnected()) return [];
  const links = await FriendLink.find({
    status: "accepted",
    $or: [{ fromDeviceId: deviceId }, { toDeviceId: deviceId }],
  }).lean();
  const otherIds = links.map((l) => (l.fromDeviceId === deviceId ? l.toDeviceId : l.fromDeviceId));
  const users = await User.find({ deviceId: { $in: otherIds } }).lean();
  const byId = Object.fromEntries(users.map((u) => [u.deviceId, u]));
  return otherIds.map((id) => ({
    deviceId: id,
    name: byId[id]?.name || "Friend",
    photoUrl: byId[id]?.photoUrl || "",
  }));
}

module.exports = { upsertUser, sendFriendRequest, respondToRequest, listIncomingRequests, listFriends };
