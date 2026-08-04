/**
 * matchmaking.js
 * --------------
 * Pairs real, currently-connected users. Never fabricates a partner —
 * if nobody compatible is waiting, the caller times out and the
 * frontend shows "no one's available right now."
 *
 * Matching priority (highest first):
 *   1. Same interests AND compatible gender preference
 *   2. Compatible gender preference only
 *   3. Random worldwide (either side chose "random", or fallback)
 */

const { v4: uuid } = require("uuid");

/** @type {Map<string, WaitingUser>} socketId -> waiting user entry */
const queue = new Map();

/**
 * @typedef {Object} WaitingUser
 * @property {string} socketId
 * @property {string} userId
 * @property {string} gender      - 'Male' | 'Female' | 'Non-binary' | 'Prefer not to say'
 * @property {string} matchType   - 'boy' | 'girl' | 'random'
 * @property {string[]} interests
 * @property {number} joinedAt
 */

function genderMatchesPreference(candidateGender, preference) {
  if (preference === "random") return true;
  if (preference === "boy") return candidateGender === "Male";
  if (preference === "girl") return candidateGender === "Female";
  return true;
}

/** Do two waiting users satisfy each other's stated match-type preference? */
function isCompatible(a, b) {
  return (
    genderMatchesPreference(b.gender, a.matchType) &&
    genderMatchesPreference(a.gender, b.matchType)
  );
}

function sharedInterestCount(a, b) {
  const setB = new Set(b.interests || []);
  return (a.interests || []).filter((i) => setB.has(i)).length;
}

/**
 * Try to find the best waiting partner for `user` among everyone else
 * currently in the queue. Returns the matched WaitingUser, or null.
 */
function findBestMatch(user) {
  let best = null;
  let bestScore = -1;

  for (const other of queue.values()) {
    if (other.socketId === user.socketId) continue;
    if (!isCompatible(user, other)) continue;

    const shared = sharedInterestCount(user, other);
    const score = shared * 10 + (other.matchType === "random" ? 1 : 0);

    if (score > bestScore) {
      bestScore = score;
      best = other;
    }
  }

  return best;
}

function addToQueue(entry) {
  queue.set(entry.socketId, entry);
}

function removeFromQueue(socketId) {
  queue.delete(socketId);
}

function isInQueue(socketId) {
  return queue.has(socketId);
}

function queueSize() {
  return queue.size;
}

function newRoomId() {
  return uuid();
}

module.exports = {
  addToQueue,
  removeFromQueue,
  isInQueue,
  queueSize,
  findBestMatch,
  newRoomId,
};
