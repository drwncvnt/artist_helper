// Regression tests for the gateway's security behavior. Runs against fake
// accounts/tool servers, so no Docker or database is needed:
//   cd gateway && npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

process.env.JWT_SECRET = 'test-jwt-secret';
const jwt = require('jsonwebtoken');
const { createApp } = require('../app');

const GW_SECRET = 'test-gateway-secret';
const sessions = new Map([['sid-alice', { id: 7, username: 'alice', plan: 'free' }]]);
const accountsLog = [];
const toolLog = [];

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

const accounts = http.createServer(async (req, res) => {
  const body = await readBody(req);
  accountsLog.push({ method: req.method, url: req.url, headers: req.headers, body });
  const json = (status, data) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(data === undefined ? '' : JSON.stringify(data));
  };
  if (req.url.startsWith('/internal/')) {
    if (req.headers['x-gateway-secret'] !== GW_SECRET) return json(403, { error: 'Forbidden.' });
    const m = req.url.match(/^\/internal\/sessions\/(.+)$/);
    if (m) {
      const user = sessions.get(decodeURIComponent(m[1]));
      return user ? json(200, { user }) : json(404, { error: 'Not found.' });
    }
    if (req.url === '/internal/users/7/verify-password' && req.method === 'POST') {
      return JSON.parse(body).password === 'right-password' ? json(204) : json(403, { error: 'Password is incorrect.' });
    }
    if (req.url === '/internal/users/7' && req.method === 'DELETE') {
      sessions.delete('sid-alice-delete');
      return json(204);
    }
    return json(404, { error: 'Not found.' });
  }
  return json(200, { ok: true });
});

const tool = http.createServer(async (req, res) => {
  const body = await readBody(req);
  toolLog.push({ method: req.method, url: req.url, headers: req.headers, size: body.length });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"ok":true}');
});

let base;
let gatewayServer;

test.before(async () => {
  const accountsPort = await listen(accounts);
  const toolPort = await listen(tool);
  const app = createApp({
    GATEWAY_SECRET: GW_SECRET,
    ACCOUNTS_URL: `http://127.0.0.1:${accountsPort}`,
    BEATS_URL: `http://127.0.0.1:${toolPort}`,
    TAGS_URL: `http://127.0.0.1:${toolPort}`,
    BEATS_MAX_UPLOAD_MB: '1',
    FEEDBACK_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'gw-feedback-')),
    ANALYTICS_ORIGIN: 'https://stats.example',
  });
  gatewayServer = http.createServer(app);
  base = `http://127.0.0.1:${await listen(gatewayServer)}`;
});

test.after(() => {
  gatewayServer.close();
  accounts.close();
  tool.close();
});

function cookieFor(claims, options = { algorithm: 'HS256' }) {
  return `dp_session=${jwt.sign(claims, process.env.JWT_SECRET, options)}`;
}
const ALICE = cookieFor({ sub: '7', username: 'alice', sid: 'sid-alice' });

// API-style request: JSON Accept header and no redirect following, so a
// rejected request shows up as 401/302 instead of the /login page it leads to.
function api(url, init = {}) {
  return fetch(url, { redirect: 'manual', ...init, headers: { accept: 'application/json', ...(init.headers || {}) } });
}

function lastTool() {
  return toolLog[toolLog.length - 1];
}

test('unauthenticated API request gets 401, page request redirects to login', async () => {
  let res = await api(`${base}/beats/api/tracks`);
  assert.equal(res.status, 401);
  res = await api(`${base}/`, { headers: { accept: 'text/html' }, redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');
});

test('identity tool receives only gateway-set identity headers, no cookies', async () => {
  const res = await api(`${base}/beats/api/tracks`, {
    headers: { cookie: ALICE, 'x-auth-user-id': '1', 'x-auth-username': 'admin', 'x-gateway-secret': 'forged' },
  });
  assert.equal(res.status, 200);
  const seen = lastTool();
  assert.equal(seen.url, '/api/tracks');
  assert.equal(seen.headers['x-auth-user-id'], '7');
  assert.equal(seen.headers['x-auth-username'], 'alice');
  assert.equal(seen.headers['x-gateway-secret'], GW_SECRET);
  assert.equal(seen.headers.cookie, undefined);
});

test('tool without identity gets neither identity nor the gateway secret', async () => {
  const res = await api(`${base}/tags/`, { headers: { cookie: ALICE, 'x-gateway-secret': 'forged' } });
  assert.equal(res.status, 200);
  const seen = lastTool();
  assert.equal(seen.headers['x-auth-user-id'], undefined);
  assert.equal(seen.headers['x-gateway-secret'], undefined);
});

test('revoked, sid-less and wrong-algorithm tokens are rejected', async () => {
  const revoked = cookieFor({ sub: '7', username: 'alice', sid: 'sid-gone' });
  const legacy = cookieFor({ sub: '7', username: 'alice' });
  const hs512 = cookieFor({ sub: '7', username: 'alice', sid: 'sid-alice' }, { algorithm: 'HS512' });
  const mismatch = cookieFor({ sub: '8', username: 'mallory', sid: 'sid-alice' });
  for (const cookie of [revoked, legacy, hs512, mismatch]) {
    const res = await api(`${base}/beats/api/tracks`, { headers: { cookie } });
    assert.equal(res.status, 401);
  }
});

test('cross-site and sibling-subdomain writes are blocked, same-origin writes pass', async () => {
  let res = await api(`${base}/beats/api/upload`, {
    method: 'POST', body: 'x', headers: { cookie: ALICE, origin: 'https://evil.example' },
  });
  assert.equal(res.status, 403);
  res = await api(`${base}/beats/api/upload`, {
    method: 'POST', body: 'x', headers: { cookie: ALICE, 'sec-fetch-site': 'same-site' },
  });
  assert.equal(res.status, 403);
  res = await api(`${base}/beats/api/upload`, {
    method: 'POST', body: 'x', headers: { cookie: ALICE, origin: base, 'sec-fetch-site': 'same-origin' },
  });
  assert.equal(res.status, 200);
});

test('oversized uploads are refused before reaching the tool', async () => {
  const before = toolLog.length;
  const res = await api(`${base}/beats/api/upload`, {
    method: 'POST', body: Buffer.alloc(3 * 1024 * 1024), headers: { cookie: ALICE, origin: base },
  });
  assert.equal(res.status, 413);
  assert.match((await res.json()).detail, /too large/);
  assert.equal(toolLog.length, before);
});

test('session checks on /api/auth/me are never rate limited', async () => {
  for (let i = 0; i < 60; i++) {
    const res = await api(`${base}/api/auth/me`, { headers: { cookie: ALICE } });
    assert.notEqual(res.status, 429);
  }
});

test('accounts gets the gateway-resolved client IP, not a client-supplied one', async () => {
  await api(`${base}/api/auth/me`, { headers: { 'x-client-ip': '203.0.113.9', 'x-gateway-secret': 'forged' } });
  const seen = accountsLog.filter((r) => r.url === '/api/auth/me').pop();
  assert.notEqual(seen.headers['x-client-ip'], '203.0.113.9');
  assert.equal(seen.headers['x-gateway-secret'], undefined);
});

test('logout drops the cached session immediately', async () => {
  sessions.set('sid-logout', { id: 7, username: 'alice', plan: 'free' });
  const cookie = cookieFor({ sub: '7', username: 'alice', sid: 'sid-logout' });
  assert.equal((await api(`${base}/beats/api/tracks`, { headers: { cookie } })).status, 200);
  sessions.delete('sid-logout'); // accounts deletes the row on logout
  await api(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie, origin: base } });
  assert.equal((await api(`${base}/beats/api/tracks`, { headers: { cookie } })).status, 401);
});

test('public share paths work without a session but carry no identity', async () => {
  const res = await api(`${base}/beats/listen/abc.DEF-123_x`);
  assert.equal(res.status, 200);
  assert.equal(lastTool().headers['x-auth-user-id'], undefined);
  assert.equal((await api(`${base}/beats/listen/a/b`)).status, 401);
  assert.equal((await api(`${base}/beats/api/stream/x.mp3`)).status, 401);
});

test('account deletion needs the password, purges tool data, then deletes the account', async () => {
  sessions.set('sid-alice-delete', { id: 7, username: 'alice', plan: 'free' });
  const cookie = cookieFor({ sub: '7', username: 'alice', sid: 'sid-alice-delete' });
  const post = (password) => api(`${base}/api/account/delete`, {
    method: 'POST',
    headers: { cookie, origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });

  const purgesBefore = toolLog.filter((r) => r.url === '/api/me/data').length;
  assert.equal((await post('wrong')).status, 403);
  assert.equal(toolLog.filter((r) => r.url === '/api/me/data').length, purgesBefore);

  const res = await post('right-password');
  assert.equal(res.status, 200);
  const purge = toolLog.filter((r) => r.url === '/api/me/data').pop();
  assert.equal(purge.method, 'DELETE');
  assert.equal(purge.headers['x-auth-user-id'], '7');
  assert.equal(purge.headers['x-gateway-secret'], GW_SECRET);
  assert.ok(accountsLog.some((r) => r.method === 'DELETE' && r.url === '/internal/users/7'));
  assert.equal((await api(`${base}/beats/api/tracks`, { headers: { cookie } })).status, 401);
});

test('CF-Connecting-IP is only trusted from Cloudflare peers', () => {
  const app = createApp({ GATEWAY_SECRET: GW_SECRET, TRUST_CF_CONNECTING_IP: 'true', FEEDBACK_DIR: os.tmpdir() });
  const req = (ip, cf) => ({ ip, get: (h) => (h === 'cf-connecting-ip' ? cf : undefined) });
  assert.equal(app.locals.clientIp(req('162.158.95.128', '198.51.100.7')), '198.51.100.7');
  assert.equal(app.locals.clientIp(req('2606:4700::1', '198.51.100.7')), '198.51.100.7');
  // A direct hit on the origin can't pick its own rate-limit key.
  assert.equal(app.locals.clientIp(req('203.0.113.50', '198.51.100.7')), '203.0.113.50');
  assert.equal(app.locals.clientIp(req('162.158.95.128', 'not-an-ip')), '162.158.95.128');
  const off = createApp({ GATEWAY_SECRET: GW_SECRET, FEEDBACK_DIR: os.tmpdir() });
  assert.equal(off.locals.clientIp(req('162.158.95.128', '198.51.100.7')), '162.158.95.128');
});

test('security headers are set on every response', async () => {
  const res = await api(`${base}/login`);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors 'self'/);
  assert.match(csp, /script-src 'self' 'unsafe-inline' https:\/\/stats\.example/);
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('strict-transport-security'), /max-age=/);
});
