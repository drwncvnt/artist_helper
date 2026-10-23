// Session lookups against the accounts service, with a short-lived cache.
//
// The session cookie is a signed JWT that carries a session id (`sid`). A valid
// signature alone is not enough: the session row must still exist in accounts,
// otherwise logout, password changes and account deletion could never revoke
// a cookie before it expires. Asking accounts on every request would add a
// round trip to each asset, so answers are cached for `ttlMs`.
//
// If accounts is unreachable, a cached answer up to `staleMs` old is reused so
// a brief accounts restart doesn't sign everyone out; with nothing cached the
// lookup throws and the caller fails closed.

class SessionStore {
  constructor({ accountsUrl, secret, ttlMs = 30_000, staleMs = 10 * 60_000, maxEntries = 10_000 }) {
    this.accountsUrl = accountsUrl;
    this.secret = secret;
    this.ttlMs = ttlMs;
    this.staleMs = staleMs;
    this.maxEntries = maxEntries;
    this.cache = new Map(); // sid -> { user|null, at }
    this.inflight = new Map(); // sid -> Promise, so a burst of requests shares one lookup
  }

  async lookup(sid) {
    const hit = this.cache.get(sid);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.user;

    if (!this.inflight.has(sid)) {
      const p = this.fetchSession(sid)
        .then((user) => {
          this.remember(sid, user);
          return user;
        })
        .finally(() => this.inflight.delete(sid));
      this.inflight.set(sid, p);
    }
    try {
      return await this.inflight.get(sid);
    } catch (err) {
      if (hit && Date.now() - hit.at < this.staleMs) return hit.user;
      throw err;
    }
  }

  async fetchSession(sid) {
    const res = await fetch(`${this.accountsUrl}/internal/sessions/${encodeURIComponent(sid)}`, {
      headers: { 'x-gateway-secret': this.secret },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`accounts session lookup failed with HTTP ${res.status}`);
    const body = await res.json();
    return body.user || null;
  }

  remember(sid, user) {
    this.cache.delete(sid);
    this.cache.set(sid, { user, at: Date.now() });
    // Map keeps insertion order, so the first key is the oldest entry.
    while (this.cache.size > this.maxEntries) {
      this.cache.delete(this.cache.keys().next().value);
    }
  }

  invalidate(sid) {
    this.cache.delete(sid);
  }

  invalidateUser(userId) {
    const id = String(userId);
    for (const [sid, entry] of this.cache) {
      if (entry.user && String(entry.user.id) === id) this.cache.delete(sid);
    }
  }
}

module.exports = { SessionStore };
