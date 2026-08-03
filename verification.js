/**
 * verification.js
 * ----------------
 * This is the ONE place a real ID/age verification provider plugs in.
 * Nothing here should be mistaken for actual verification — it's the
 * integration point, not the implementation.
 *
 * How this is meant to work in production:
 *
 *   1. User signs up on your frontend and is redirected to your
 *      verification provider's hosted flow (e.g. Persona, Veriff, Yoti),
 *      or their SDK modal opens client-side.
 *   2. The provider verifies a government ID + liveness check and calls
 *      YOUR backend's webhook (e.g. POST /webhooks/verification) with a
 *      signed payload saying pass/fail for that user.
 *   3. You verify the webhook signature with VERIFICATION_PROVIDER_WEBHOOK_SECRET,
 *      then call markUserVerified(userId) below.
 *   4. Only verified users are allowed into the matching queue — enforced
 *      in server.js's enterMatchQueue(), which checks isVerified(userId)
 *      before letting anyone into the queue.
 *
 * Until a real provider is wired in here, every session is unverified by
 * default. That is intentional — it's the honest state, not a bug.
 */

// In-memory store for demo purposes. Replace with a real database
// (Postgres/Redis) — this resets on every server restart.
const verifiedUsers = new Map(); // userId -> { verifiedAt, provider }

function isVerified(userId) {
  return verifiedUsers.has(userId);
}

function markUserVerified(userId, provider = "unknown") {
  verifiedUsers.set(userId, { verifiedAt: Date.now(), provider });
}

function revokeVerification(userId) {
  verifiedUsers.delete(userId);
}

/**
 * Express handler stub for a verification-provider webhook.
 * Wire your real provider's payload shape + signature check in here.
 */
function verificationWebhookHandler(req, res) {
  // Example shape — replace with your provider's actual payload/signature scheme:
  // const signature = req.headers['x-provider-signature'];
  // if (!verifySignature(req.body, signature, process.env.VERIFICATION_PROVIDER_WEBHOOK_SECRET)) {
  //   return res.status(401).json({ error: 'invalid signature' });
  // }
  // const { userId, status } = req.body;
  // if (status === 'approved') markUserVerified(userId, 'persona');
  // else revokeVerification(userId);

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
