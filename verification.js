/**
 * verification.js
 * ----------------
 * This is the ONE place a real ID/age verification provider plugs in.
 * Nothing here should be mistaken for actual verification.
 */

const verifiedUsers = new Map();

function isVerified(userId) {
  return verifiedUsers.has(userId);
}

function markUserVerified(userId, provider = "unknown") {
  verifiedUsers.set(userId, { verifiedAt: Date.now(), provider });
}

function revokeVerification(userId) {
  verifiedUsers.delete(userId);
}

function verificationWebhookHandler(req, res) {
  res.status(501).json({
    error:
      "No verification provider is wired up yet. See src/verification.js for the integration point.",
  });
}

module.exports = {
  isVerified,
  markUserVerified,
  revokeVerification,
  verificationWebhookHandler,
};
