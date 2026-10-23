const crypto = require('crypto');
const net = require('net');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { pool, init } = require('./db');
const { sign, verify, cookieOptions, COOKIE_NAME, TTL_SECONDS } = require('./jwt');

const PORT = process.env.PORT || 4100;
const GATEWAY_SECRET = process.env.GATEWAY_SECRET;
if (!GATEWAY_SECRET) {
  console.error('GATEWAY_SECRET env var is required');
  process.exit(1);
}

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_PASSWORD_LENGTH = 8;
// bcrypt only looks at the first 72 bytes; the cap just keeps hashing cheap.
const MAX_PASSWORD_LENGTH = 256;
const BCRYPT_COST = 12;
// Compared against when the username doesn't exist, so a login attempt costs
// the same time either way and response timing can't reveal valid usernames.
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer', BCRYPT_COST);

const app = express();
app.disable('x-powered-by');
// Requests reach this service only through the gateway (a trusted proxy).
app.set('trust proxy', 1);
app.use(express.json({ limit: '16kb' }));
app.use(cookieParser());

// Express 4 does not catch rejected promises from async handlers: without
// this wrapper a database error would become an unhandled rejection, which
// terminates the Node process.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// The gateway resolves the real client address (behind Cloudflare and Nginx
// Proxy Manager) and passes it in X-Client-IP, overwriting anything the client
// sent. Fall back to the socket address for direct local testing.
function clientIp(req) {
  const fromGateway = req.get('x-client-ip');
  return fromGateway && net.isIP(fromGateway) ? fromGateway : req.ip;
}

function limiter(opts) {
  return rateLimit({
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: clientIp,
    ...opts,
  });
}

// Account creation per address. Low on purpose: every account gets storage in
// the tools, so mass sign-ups are the cheapest way to abuse the platform.
const registerLimiter = limiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many new accounts from this network. Please try again later.' },
});
// Failed logins per address (successful ones don't count).
const loginIpLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  skipSuccessfulRequests: true,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});
// Failed logins per username, so a distributed attack (many addresses, one
// account) is still slowed down.
const loginUserLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `user:${String(req.body?.username || '').toLowerCase()}`,
  message: { error: 'Too many attempts for this account. Please wait a few minutes and try again.' },
});
// Wrong current-password attempts on the password change form.
const passwordLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});
// Same idea for the gateway-driven account deletion check, keyed by account.
const deletePasswordLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `uid:${req.params.id}`,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});

function publicUser(row) {
  return { id: Number(row.id), username: row.username, email: row.email, plan: row.plan };
}

function validPassword(password) {
  return (
    typeof password === 'string' &&
    password.length >= MIN_PASSWORD_LENGTH &&
    password.length <= MAX_PASSWORD_LENGTH
  );
}

async function createSession(res, user) {
  const { rows } = await pool.query(
    `INSERT INTO sessions (user_id, expires_at)
     VALUES ($1, now() + make_interval(secs => $2))
     RETURNING id`,
    [user.id, TTL_SECONDS]
  );
  res.cookie(COOKIE_NAME, sign(user, rows[0].id), cookieOptions());
}

// Resolves the session cookie to { sid, user } while the session row exists
// and hasn't expired; null otherwise (missing, forged, expired or revoked).
async function currentSession(req) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return null;
  let claims;
  try {
    claims = verify(token);
  } catch {
    return null;
  }
  if (typeof claims.sid !== 'string' || !UUID_RE.test(claims.sid)) return null;
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.email, u.plan
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now()`,
    [claims.sid]
  );
  return rows[0] ? { sid: claims.sid, user: rows[0] } : null;
}

function requireNumericId(req, res, next) {
  if (!/^\d{1,18}$/.test(req.params.id)) return res.status(404).json({ error: 'Not found.' });
  next();
}

function requireGateway(req, res, next) {
  const given = Buffer.from(String(req.get('x-gateway-secret') || ''));
  const expected = Buffer.from(GATEWAY_SECRET);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return res.status(403).json({ error: 'Forbidden.' });
  }
  next();
}

app.get('/health', (req, res) => res.json({ ok: true }));

// ---- Public auth API (proxied by the gateway at /api/auth) ----------------

app.post('/api/auth/register', registerLimiter, wrap(async (req, res) => {
  const { username, password, email } = req.body || {};

  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-20 characters: letters, numbers, underscore.' });
  }
  if (!validPassword(password)) {
    return res.status(400).json({ error: `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters.` });
  }
  if (email != null && email !== '' && (typeof email !== 'string' || email.length > 254 || !EMAIL_RE.test(email))) {
    return res.status(400).json({ error: 'Enter a valid email address, or leave it blank.' });
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  let user;
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (username, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, username, email, plan`,
      [username, email ? email : null, passwordHash]
    );
    user = rows[0];
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'That username is already taken.' });
    }
    throw err;
  }
  await createSession(res, user);
  res.status(201).json({ user: publicUser(user) });
}));

app.post('/api/auth/login', loginIpLimiter, loginUserLimiter, wrap(async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const { rows } = await pool.query(
    'SELECT * FROM users WHERE lower(username) = lower($1)',
    [username]
  );
  const user = rows[0];
  const valid = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);

  if (!user || !valid) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  await createSession(res, user);
  res.json({ user: publicUser(user) });
}));

app.post('/api/auth/logout', wrap(async (req, res) => {
  const token = req.cookies[COOKIE_NAME];
  if (token) {
    try {
      const claims = verify(token);
      if (typeof claims.sid === 'string' && UUID_RE.test(claims.sid)) {
        await pool.query('DELETE FROM sessions WHERE id = $1', [claims.sid]);
      }
    } catch {
      // An invalid token has nothing to revoke; still clear the cookie below.
    }
  }
  res.clearCookie(COOKIE_NAME, { ...cookieOptions(), maxAge: undefined });
  res.json({ ok: true });
}));

app.get('/api/auth/me', wrap(async (req, res) => {
  const session = await currentSession(req);
  res.json({ user: session ? publicUser(session.user) : null });
}));

// Change password: requires the current one, then signs out every other
// device by dropping all of the user's sessions and issuing a fresh one here.
app.post('/api/auth/password', passwordLimiter, wrap(async (req, res) => {
  const session = await currentSession(req);
  if (!session) return res.status(401).json({ error: 'Please sign in again.' });

  const { current_password: currentPassword, new_password: newPassword } = req.body || {};
  if (typeof currentPassword !== 'string' || currentPassword.length > MAX_PASSWORD_LENGTH) {
    return res.status(400).json({ error: 'Enter your current password.' });
  }
  if (!validPassword(newPassword)) {
    return res.status(400).json({ error: `New password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters.` });
  }

  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [session.user.id]);
  if (!rows[0] || !(await bcrypt.compare(currentPassword, rows[0].password_hash))) {
    return res.status(403).json({ error: 'Current password is incorrect.' });
  }

  const hash = await bcrypt.hash(newPassword, BCRYPT_COST);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, session.user.id]);
    await client.query('DELETE FROM sessions WHERE user_id = $1', [session.user.id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await createSession(res, session.user);
  res.json({ ok: true });
}));

// ---- Internal API (gateway only, never proxied to the outside) ------------

// Session lookup used by the gateway's session gate.
app.get('/internal/sessions/:sid', requireGateway, wrap(async (req, res) => {
  if (!UUID_RE.test(req.params.sid)) return res.status(404).json({ error: 'Not found.' });
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.plan
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now()`,
    [req.params.sid]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found.' });
  res.json({ user: { id: Number(rows[0].id), username: rows[0].username, plan: rows[0].plan } });
}));

// Account deletion is a two-step flow driven by the gateway: check the
// password, let every tool purge the user's data, then delete the account.
app.post('/internal/users/:id/verify-password', requireGateway, requireNumericId, deletePasswordLimiter, wrap(async (req, res) => {
  const { password } = req.body || {};
  if (typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) {
    return res.status(400).json({ error: 'Enter your password.' });
  }
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.params.id]);
  if (!rows[0] || !(await bcrypt.compare(password, rows[0].password_hash))) {
    return res.status(403).json({ error: 'Password is incorrect.' });
  }
  res.status(204).end();
}));

app.delete('/internal/users/:id', requireGateway, requireNumericId, wrap(async (req, res) => {
  // Sessions go with it (ON DELETE CASCADE).
  await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
  res.status(204).end();
}));

app.use((err, req, res, next) => {
  console.error('accounts error', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

init()
  .then(() => {
    // Expired sessions are already ignored by every lookup; this just keeps
    // the table from growing forever.
    setInterval(() => {
      pool.query('DELETE FROM sessions WHERE expires_at < now()').catch((err) => {
        console.warn('session cleanup failed:', err.code || err.message);
      });
    }, 60 * 60 * 1000).unref();
    app.listen(PORT, () => console.log(`accounts service listening on ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
