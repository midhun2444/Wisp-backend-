/**
 * reports.js
 * ----------
 * Minimal in-memory report log. Replace with a real database + an actual
 * moderation queue/dashboard before going to production — reports need
 * humans reviewing them, and this alone doesn't ban anyone.
 *
 * Capped at MAX_REPORTS entries (oldest dropped first) so this can't grow
 * without bound on a long-running server — a real memory leak the
 * original version had, since the array only ever grew.
 */

const MAX_REPORTS = 2000;
const reports = [];
let nextId = 1; // monotonic — safe even after old reports are dropped

function fileReport({ reporterId, reportedId, roomId, reason, details }) {
  const report = {
    id: nextId++,
    reporterId,
    reportedId,
    roomId,
    reason,
    details: details || "",
    createdAt: Date.now(),
    status: "open", // open | reviewed | actioned | dismissed
  };
  reports.push(report);
  if (reports.length > MAX_REPORTS) {
    reports.splice(0, reports.length - MAX_REPORTS);
  }
  // eslint-disable-next-line no-console
  console.warn(
    `[report] user ${reporterId} reported ${reportedId} in room ${roomId} — reason: ${reason}`
  );
  return report;
}

function listReports() {
  return reports;
}

module.exports = { fileReport, listReports };
