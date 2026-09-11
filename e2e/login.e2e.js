// e2e/login.e2e.js
//
// The one thing the whole test suite could not tell us: does the sign-in
// screen actually work in a browser?
//
// Everything else is exercised from Node — the API from both sides, the guards,
// the parsers. But the login page is HttpOnly cookies, a React router, a
// redirect and a form, and none of that is testable without a real browser
// engine. Until this file existed, the honest answer to "has anyone logged in?"
// was no.
//
// Run with:  npm run test:e2e
//
// Deliberately NOT part of `npm test`. That suite has to stay fast and
// installable anywhere; this one needs a ~150 MB browser download. CI runs
// both. It lives outside server/test/ because `node --test` auto-discovers
// everything under a directory named `test`, and picking this up there would
// make the fast suite quietly depend on a browser.
//
// It builds the frontend and serves it from the API on ONE port, which is also
// how production runs: same origin, so the session cookie is SameSite=Lax and
// no CORS is involved. Testing the dev two-port setup instead would be testing
// an arrangement nobody deploys.

'use strict';

const { spawn, execFileSync } = require('child_process');
const path = require('path');
const net = require('net');

const REPO_ROOT = path.join(__dirname, '..');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error(
    '\nPlaywright is not installed.\n' +
    '  This suite drives a real browser, so it needs one:\n\n' +
    '    npm install -D playwright\n' +
    '    npx playwright install chromium\n\n' +
    '  It is intentionally separate from `npm test`, which needs no browser.\n'
  );
  process.exit(1);
}

// --- a tiny assert/report harness -------------------------------------------
// node:test cannot be used here: its runner would need this file to be a test
// file, and that is exactly what pulls it into the fast suite.
const results = [];
let currentName = null;

async function check(name, fn) {
  currentName = name;
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok    ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || `assertion failed in "${currentName}"`);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'not equal'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// --- environment -------------------------------------------------------------
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function buildFrontend() {
  console.log('Building the frontend for same-origin serving…');
  execFileSync('npx', ['vite', 'build'], {
    cwd: path.join(REPO_ROOT, 'web'),
    stdio: 'inherit',
    // Empty string, not unset. api.js treats '' as "same origin" and an unset
    // variable as "http://localhost:4000" — the dev default, which would send
    // every request from this test to whatever else is running on that port.
    env: { ...process.env, VITE_API_BASE_URL: '' },
  });
}

function startServer(port) {
  const server = spawn(process.execPath, [path.join('server', 'src', 'index.js')], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'development',
      // This suite makes a deliberate wrong-password attempt, and re-runs
      // accumulate against the per-IP login limiter's 15-minute window — after
      // a few runs every sign-in here returns 429 and the failure looks like a
      // broken login page. The flag is honoured ONLY outside production
      // (see middleware/rateLimit.js), so it cannot weaken a deployment.
      // The limiter itself is covered by server/test/auth.test.js, which
      // asserts it engages and that a correct password does not walk past a
      // locked account.
      DISABLE_RATE_LIMIT: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.env.E2E_VERBOSE && process.stdout.write(`[server] ${d}`));
  server.stderr.on('data', (d) => process.env.E2E_VERBOSE && process.stderr.write(`[server] ${d}`));
  return server;
}

async function waitForServer(baseUrl, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`the server did not answer /health within ${timeoutMs}ms`);
}

// --- the run -----------------------------------------------------------------
async function main() {
  require(path.join(REPO_ROOT, 'config', 'env'));
  const db = require(path.join(REPO_ROOT, 'server', 'src', 'config', 'db'));
  const { hashPassword } = require(path.join(REPO_ROOT, 'server', 'src', 'services', 'password'));

  const suffix = Math.random().toString(36).slice(2, 8);
  const engineer = { email: `e2e-eng-${suffix}@example.invalid`, password: 'e2e-test-password-1234' };
  const admin = { email: `e2e-admin-${suffix}@example.invalid`, password: 'e2e-test-password-1234' };

  let server;
  let browser;

  try {
    await db.query('SELECT 1');

    for (const [user, role] of [[engineer, 'sales_engineer'], [admin, 'admin']]) {
      await db.query(
        `INSERT INTO users (name, email, role, active, password_hash) VALUES ($1,$2,$3,TRUE,$4)`,
        [`E2E ${role}`, user.email, role, await hashPassword(user.password)]
      );
    }

    buildFrontend();

    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    server = startServer(port);
    await waitForServer(baseUrl);
    console.log(`Server up on ${baseUrl}\n`);

    browser = await chromium.launch();

    // ---------------------------------------------------------------- sign-in
    let context = await browser.newContext();
    let page = await context.newPage();

    await check('the login page renders', async () => {
      await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle' });
      await page.waitForSelector('input[type="email"]', { timeout: 10_000 });
      assert(await page.isVisible('input[type="password"]'), 'no password field');
      assert(await page.isVisible('button[type="submit"]'), 'no submit button');
    });

    await check('a visitor with no session is sent to /login', async () => {
      await page.goto(`${baseUrl}/chat`, { waitUntil: 'networkidle' });
      assert(page.url().includes('/login'), `expected /login, got ${page.url()}`);
    });

    await check('wrong credentials show an error and do NOT sign in', async () => {
      await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle' });
      await page.fill('input[type="email"]', engineer.email);
      await page.fill('input[type="password"]', 'definitely-not-the-password');
      await page.click('button[type="submit"]');
      await page.waitForSelector('[role="alert"]', { timeout: 10_000 });
      const message = await page.textContent('[role="alert"]');
      assert(/invalid/i.test(message), `unhelpful error: ${message}`);
      assert(page.url().includes('/login'), 'a failed sign-in navigated away from /login');
    });

    await check('the password field is cleared after a failed attempt', async () => {
      assertEqual(await page.inputValue('input[type="password"]'), '', 'password left in the field');
    });

    await check('correct credentials sign a sales engineer in', async () => {
      await page.fill('input[type="email"]', engineer.email);
      await page.fill('input[type="password"]', engineer.password);
      await page.click('button[type="submit"]');
      await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15_000 });
      assert(page.url().includes('/chat'), `expected /chat, got ${page.url()}`);
    });

    await check('the session cookie is HttpOnly and is NOT readable by page script', async () => {
      // The control that stops an XSS payload stealing a session. Asserted from
      // inside the page, which is where an attacker would be.
      const cookies = await context.cookies();
      const session = cookies.find((c) => c.name === 'fm_session');
      assert(session, 'no fm_session cookie was set');
      assertEqual(session.httpOnly, true, 'the session cookie is not HttpOnly');
      const visible = await page.evaluate(() => document.cookie);
      assert(!visible.includes('fm_session'), `page script can read the session: ${visible}`);
    });

    await check('nothing sensitive was written to localStorage', async () => {
      // The old design put the role in localStorage and called it auth.
      const stored = await page.evaluate(() => JSON.stringify(Object.entries(localStorage)));
      assert(!/fm_role/.test(stored), `fm_role is back in localStorage: ${stored}`);
      assert(!/password|token|fm_session/i.test(stored), `a credential is in localStorage: ${stored}`);
    });

    await check('the signed-in user is named on screen', async () => {
      const bar = await page.textContent('.top-bar');
      assert(/Sales Engineer/i.test(bar), `role not shown: ${bar}`);
    });

    await check('a refresh keeps the user signed in', async () => {
      // The /auth/me round-trip on mount. If it regressed, a refresh would
      // bounce a signed-in user to the login screen.
      await page.reload({ waitUntil: 'networkidle' });
      assert(!page.url().includes('/login'), `a refresh signed the user out: ${page.url()}`);
    });

    await check('an engineer visiting /admin is redirected away', async () => {
      await page.goto(`${baseUrl}/admin`, { waitUntil: 'networkidle' });
      assert(!page.url().includes('/admin'), `an engineer reached ${page.url()}`);
    });

    await check('the admin API refuses the engineer even when called directly', async () => {
      // The redirect above is cosmetic. THIS is the control.
      const status = await page.evaluate(async (url) => {
        const res = await fetch(`${url}/catalogue-uploads`, { credentials: 'include' });
        return res.status;
      }, baseUrl);
      assertEqual(status, 403, 'an engineer could read the catalogue library');
    });

    await check('logging out ends the session server-side, not just in the UI', async () => {
      await page.goto(`${baseUrl}/chat`, { waitUntil: 'networkidle' });
      await page.click('.top-bar-logout');
      await page.waitForURL((url) => url.pathname.includes('/login'), { timeout: 15_000 });

      const status = await page.evaluate(async (url) => {
        const res = await fetch(`${url}/auth/me`, { credentials: 'include' });
        return res.status;
      }, baseUrl);
      assertEqual(status, 401, 'the session still worked after logging out');
    });

    await check('the previous user\'s chat history does not survive logout', async () => {
      // Shared machines in a sales office: each history entry is a full
      // snapshot of a customer's enquiry.
      const stored = await page.evaluate(() => localStorage.getItem('fm_chat_history'));
      assert(stored === null || stored === '[]', `history left behind: ${stored}`);
    });

    await check('a protected page after logout goes back to /login', async () => {
      await page.goto(`${baseUrl}/chat`, { waitUntil: 'networkidle' });
      assert(page.url().includes('/login'), `reached ${page.url()} with no session`);
    });

    // ------------------------------------------------------------------ admin
    await context.close();
    context = await browser.newContext();
    page = await context.newPage();

    await check('an admin signs in and lands on the admin dashboard', async () => {
      await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle' });
      await page.fill('input[type="email"]', admin.email);
      await page.fill('input[type="password"]', admin.password);
      await page.click('button[type="submit"]');
      await page.waitForURL((url) => url.pathname.includes('/admin'), { timeout: 15_000 });
    });

    await check('the admin dashboard shows REAL enquiries, not mock data', async () => {
      // It used to render six invented enquiries attributed to Reliance, Tata
      // Steel and NTPC, with the counters above summing those fake rows.
      await page.waitForLoadState('networkidle');
      const body = await page.textContent('body');
      for (const invented of ['Reliance Refinery', 'Tata Steel', 'ITC Foods', 'JSW Cement', 'ENQ-1042']) {
        assert(!body.includes(invented), `fabricated enquiry still on screen: ${invented}`);
      }
    });

    await check('an empty enquiry log says so instead of showing nothing', async () => {
      const body = await page.textContent('body');
      assert(/no enquiries|enquiry log/i.test(body), 'no empty state and no table');
    });

    await check('the admin can reach the catalogue manager', async () => {
      await page.goto(`${baseUrl}/admin/catalogues`, { waitUntil: 'networkidle' });
      assert(page.url().includes('/admin/catalogues'), `redirected to ${page.url()}`);
    });

    await check('a signed-in user visiting /login is redirected to their home', async () => {
      await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle' });
      assert(!page.url().includes('/login'), `an admin was shown the login screen: ${page.url()}`);
    });

    await check('no CSP violations and no uncaught exceptions', async () => {
      // Split from "no console errors at all" deliberately.
      //
      // A CSP violation and an uncaught exception are OUR bugs and fail this
      // check — the font rule found one: styleSrc was 'self' only, so the
      // brand's Roboto @import was refused and the deployed app silently fell
      // back to a system font.
      //
      // A blocked EXTERNAL resource is not necessarily a bug: this container
      // has no route to fonts.googleapis.com, and a customer network may not
      // either. Those are reported, not failed — index.css documents how to
      // self-host Roboto if the app has to run somewhere restricted.
      const violations = [];
      const exceptions = [];
      const blockedExternal = [];

      page.on('console', (msg) => {
        if (msg.type() !== 'error') return;
        const text = msg.text();
        if (/Content Security Policy/i.test(text)) violations.push(text);
        else if (/ERR_(TUNNEL|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|CONNECTION_)/i.test(text)) blockedExternal.push(text);
        else violations.push(text);
      });
      page.on('pageerror', (err) => exceptions.push(err.message));

      for (const route of ['/admin', '/admin/catalogues']) {
        await page.goto(`${baseUrl}${route}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(300);
      }

      if (blockedExternal.length) {
        console.log(`        (note: ${blockedExternal.length} external resource(s) unreachable from this network — not a fault in the app)`);
      }
      assertEqual(exceptions.length, 0, `uncaught exceptions: ${exceptions.join(' | ')}`);
      assertEqual(violations.length, 0, `console errors: ${violations.join(' | ')}`);
    });

    await check('no page scrolls sideways at phone width', async () => {
      // Named routes, checked one at a time. The first version of this check
      // resized the page and loaded /login — but the context was signed in as
      // an admin, so RedirectIfSignedIn bounced it to /admin and the failure
      // it reported was on a page it never named. It found two real bugs
      // anyway (a top bar that could not shrink, and the catalogue table
      // pushing the document 166px wide), which is why the route is now
      // explicit and reported.
      const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const phonePage = await phone.newPage();
      const failures = [];
      try {
        await phonePage.goto(`${baseUrl}/login`, { waitUntil: 'networkidle' });
        await phonePage.fill('input[type="email"]', admin.email);
        await phonePage.fill('input[type="password"]', admin.password);
        await phonePage.click('button[type="submit"]');
        await phonePage.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15_000 });

        for (const route of ['/admin', '/admin/catalogues', '/chat', '/history']) {
          await phonePage.goto(`${baseUrl}${route}`, { waitUntil: 'networkidle' });
          const overflow = await phonePage.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth
          );
          if (overflow > 1) failures.push(`${route} overflows by ${overflow}px`);
        }
      } finally {
        await phone.close();
      }
      assert(failures.length === 0, failures.join('; '));
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.kill('SIGTERM');
    try {
      await db.query('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)', ['e2e-%@example.invalid']);
      await db.query('DELETE FROM users WHERE email LIKE $1', ['e2e-%@example.invalid']);
      await db.pool.end();
    } catch { /* teardown is best-effort; the report below still matters */ }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
  if (failed.length) {
    console.log('\nFailures:');
    for (const f of failed) console.log(`  - ${f.name}\n      ${f.err.message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nE2E run could not complete:', err);
  process.exit(1);
});
