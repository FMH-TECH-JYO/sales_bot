// server/src/index.js
//
// config/env.js must be the FIRST require in the process: it resolves the
// repo-root .env (creating it from .env.example on a fresh clone) before any
// module that reads process.env at import time is loaded.
require('../../config/env');

const express = require('express');
const cors = require('cors');
const db = require('./config/db');

// Last-resort safety net — logs instead of silently crashing. Route-level
// errors should never reach this (asyncHandler + the error middleware below
// catch those); this is only for anything outside the request/response cycle.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

// web/ built files that npm run build --workspace=web produces
const path = require('path');
const webDist = path.join(__dirname, '..', '..', 'web', 'dist');

const app = express();
app.use(cors());
app.use(express.json());

// Health check — also proves the DB connection and confirms the seed ran.
app.get('/health', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT COUNT(*)::int AS product_count FROM products');
    res.json({ status: 'ok', product_count: rows[0].product_count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.use('/products', require('./routes/products'));
app.use('/categories', require('./routes/categories'));
app.use('/catalogue-uploads', require('./routes/catalogueUploads'));
app.use('/enquiries', require('./routes/enquiries'));
app.use('/offers', require('./routes/offers'));

// Serve the built React app (if it exists) from this same server/port, so
// sharing the app is a single URL/tunnel instead of two. Falls back to the
// friendly JSON root below when web/dist hasn't been built yet (normal dev
// workflow of running Vite separately on :5173 still works either way).
const fs = require('fs');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  // SPA fallback: any non-API GET that isn't a static file goes to index.html
  // so React Router's client-side routes (e.g. /chat, /matching) work on refresh.
  // enquiries|offers are listed here too — they were missing, so a GET to
  // either would have been swallowed by the SPA fallback rather than 404ing
  // as an API route, once web/dist existed.
  app.get(/^(?!\/(products|categories|catalogue-uploads|enquiries|offers|health)).*/, (req, res) => {
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

// Global error handler — MUST be registered last, after all routes.
// Every async route is wrapped in asyncHandler, so any thrown/rejected
// error lands here instead of crashing the process.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});
// Friendly root — otherwise hitting http://localhost:4000/ shows Express's
// bare "Cannot GET /", which looks like a crash even when the server is fine.
app.get('/', (req, res) => {
  res.json({
    service: 'fm-platform-server',
    status: 'running',
    try: ['/health', '/products', '/categories', '/catalogue-uploads', '/enquiries/match', '/offers'],
  });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`FM platform server listening on :${PORT}`));
