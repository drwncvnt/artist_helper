const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  console.error('JWT_SECRET env var is required');
  process.exit(1);
}

// Must match the accounts service. The gateway only ever *verifies* tokens;
// issuing them is the accounts service's job.
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'dp_session';

function verify(token) {
  return jwt.verify(token, SECRET);
}

module.exports = { verify, COOKIE_NAME };
