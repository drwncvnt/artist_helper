const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { pool, init } = require('./db');
const { sign, verify, cookieOptions, COOKIE_NAME } = require('./jwt');

const PORT = process.env.PORT || 4100;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MIN_PASSWORD_LENGTH = 8;

const app = express();
app.disable('x-powered-by');
// Requests reach this service only through the gateway (a trusted proxy), so
// honor X-Forwarded-* for correct client IPs in rate limiting.
app.set('trust proxy', 1);
app.use(express.json({ limit: '16kb' }));
app.use(cookieParser());

// Brute-force protection on the credential endpoints.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});

function publicUser(row) {
  return { id: Number(row.id), username: row.username, email: row.email, plan: row.plan };
}

function issueSession(res, user) {
  const token = sign(user);
  res.cookie(COOKIE_NAME, token, cookieOptions());
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { username, password, email } = req.body || {};

  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-20 characters: letters, numbers, underscore.' });
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
  }
  if (email != null && email !== '' && (typeof email !== 'string' || !EMAIL_RE.test(email))) {
    return res.status(400).json({ error: 'Enter a valid email address, or leave it blank.' });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (username, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, username, email, plan`,
      [username, email ? email : null, passwordHash]
    );
    const user = rows[0];
    issueSession(res, user);
    res.status(201).json({ user: publicUser(user) });
  } catch (err) {
    if (err.code === '23505') {
      // unique_violation — figure out which field collided
      const field = String(err.detail || '').includes('email') ? 'email address' : 'username';
      return res.status(409).json({ error: `That ${field} is already registered.` });
    }
    console.error('register error', err);
    res.status(500).json({ error: 'Could not create account.' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  const user = rows[0];

  // Always run a bcrypt comparison to keep timing uniform whether or not the
  // username exists (avoids leaking valid usernames via response time).
  const hash = user ? user.password_hash : '$2a$12$0000000000000000000000000000000000000000000000000000';
  const valid = await bcrypt.compare(password, hash);

  if (!user || !valid) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  issueSession(res, user);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { ...cookieOptions(), maxAge: undefined });
  res.json({ ok: true });
});

app.get('/api/auth/me', async (req, res) => {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.json({ user: null });
  try {
    const claims = verify(token);
    // Re-read from the DB so plan changes take effect without re-login.
    const { rows } = await pool.query(
      'SELECT id, username, email, plan FROM users WHERE id = $1',
      [claims.sub]
    );
    if (!rows[0]) return res.json({ user: null });
    res.json({ user: publicUser(rows[0]) });
  } catch {
    res.json({ user: null });
  }
});

init()
  .then(() => {
    app.listen(PORT, () => console.log(`accounts service listening on ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
