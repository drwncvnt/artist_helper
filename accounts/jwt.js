const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  console.error('JWT_SECRET env var is required');
  process.exit(1);
}

// Name of the shared session cookie. The gateway verifies the same cookie with
// the same secret, so both services must agree on this value.
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'dp_session';
const TTL_SECONDS = parseInt(process.env.SESSION_TTL_SECONDS || '2592000', 10); // 30d
const ALGORITHM = 'HS256';

// `sid` points at a row in the sessions table. A token is only honored while
// that row exists, which is what makes logout and password changes effective.
function sign(user, sessionId) {
  return jwt.sign(
    { sub: String(user.id), username: user.username, plan: user.plan, sid: sessionId },
    SECRET,
    { algorithm: ALGORITHM, expiresIn: TTL_SECONDS }
  );
}

function verify(token) {
  return jwt.verify(token, SECRET, { algorithms: [ALGORITHM] });
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    path: '/',
    maxAge: TTL_SECONDS * 1000,
  };
}

module.exports = { sign, verify, cookieOptions, COOKIE_NAME, TTL_SECONDS };
