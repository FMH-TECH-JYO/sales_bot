// server/src/index.js
//
// Process entry point: takes the app built in app.js, listens on a port, and
// owns everything that is a side effect of being a running process —
// crash handling, the session-purge timer, graceful shutdown.
//
// config/env.js is required first (transitively, via app.js, which requires it
// on its own first line) so the repo-root .env is resolved before any module
// reads process.env at import time.

const { app } = require('./app');
const db = require('./config/db');
const { purgeExpiredSessions } = require('./services/sessions');
const { checkProductionPrerequisites } = require('./preflight');

// Configuration checks BEFORE the port is opened. A fatal finding here means
// the process would run without a protection it is supposed to have, or in a
// state where nothing can reach it — better to fail the deploy than to serve.
const preflight = checkProductionPrerequisites();
if (!preflight.ok) {
  console.error('\nRefusing to start. Fix the FATAL items above.\n');
  process.exit(1);
}

// --- process-level safety ----------------------------------------------------
// This used to log the rejection and carry on. That is worse than it sounds:
// a process that has had an unhandled rejection is in an unknown state but is
// still bound to :4000, so the next `npm run dev:server` fails with EADDRINUSE
// against a server that no longer works — precisely the confusing failure seen
// during development.
//
// Route errors never reach here (asyncHandler plus the error middleware in
// app.js catch those), so anything that does is genuinely unexpected. Log it,
// then exit non-zero and let the supervisor — systemd, Docker, the platform —
// start a clean process. Never leave a half-dead server holding the port.
function fatal(label) {
  return (reason) => {
    console.error(`${label}:`, reason);
    // One tick for the log to flush, then leave.
    setTimeout(() => process.exit(1), 100).unref();
  };
}
process.on('unhandledRejection', fatal('Unhandled promise rejection'));
process.on('uncaughtException', fatal('Uncaught exception'));

const PORT = Number(process.env.PORT) || 4000;

const server = app.listen(PORT, () => {
  console.log(`FM platform server listening on :${PORT} (${process.env.NODE_ENV || 'development'})`);
});

// Expired sessions are cleaned up hourly rather than on every request.
const purgeTimer = setInterval(() => {
  purgeExpiredSessions().catch((err) => console.error('Session purge failed:', err.message));
}, 60 * 60 * 1000);
purgeTimer.unref();

// --- graceful shutdown -------------------------------------------------------
// Without this, stopping the container kills in-flight requests mid-response
// and leaves Postgres connections to time out from the server side.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — finishing in-flight requests…`);
  server.close(async () => {
    try {
      await db.pool.end();
    } catch (err) {
      console.error('Error closing the database pool:', err.message);
    }
    process.exit(0);
  });
  // If something is wedged, do not hang the deployment forever.
  setTimeout(() => {
    console.error('Shutdown timed out after 10s — exiting anyway.');
    process.exit(1);
  }, 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { app, server };
