const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

// Idempotent schema + migrations, safe to run on every start.
//
// - Usernames are unique case-insensitively, so "Admin" and "admin" can never
//   be two different accounts.
// - Email is optional contact info and deliberately NOT unique: a uniqueness
//   check would let anyone probe whether an address is registered here.
// - Every login creates a row in `sessions`; the session cookie only carries
//   the session id. Deleting the row (logout, password change, account
//   deletion) revokes that cookie immediately instead of it staying valid
//   until the JWT expires.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id            BIGSERIAL PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    email         TEXT,
    password_hash TEXT NOT NULL,
    plan          TEXT NOT NULL DEFAULT 'free',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_key ON users (lower(username));
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;

  CREATE TABLE IF NOT EXISTS sessions (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
`;

// Wait for Postgres to accept connections, then ensure the schema exists.
// The compose healthcheck usually gets us there, but retrying keeps the
// service resilient to ordering races on a cold `docker compose up`.
async function init(retries = 20) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await pool.query(SCHEMA);
      return;
    } catch (err) {
      if (attempt === retries) throw err;
      console.warn(`DB not ready (attempt ${attempt}/${retries}): ${err.code || err.message}`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

module.exports = { pool, init };
