const fs = require('fs');
const net = require('net');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { verify, COOKIE_NAME } = require('./jwt');
const { SessionStore } = require('./sessions');

const MB = 1024 * 1024;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Headers only the gateway may set on upstream requests. Any client-supplied
// copy is removed before proxying.
const TRUSTED_HEADERS = ['x-auth-user-id', 'x-auth-username', 'x-gateway-secret', 'x-client-ip'];

// Cloudflare's published edge ranges (https://www.cloudflare.com/ips/).
// Overridable with CLOUDFLARE_IP_RANGES (comma-separated CIDRs) if they change.
const CLOUDFLARE_RANGES = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
  '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];

function blockListFrom(cidrs) {
  const list = new net.BlockList();
  for (const cidr of cidrs) {
    const [address, prefix] = cidr.trim().split('/');
    const family = net.isIPv6(address) ? 'ipv6' : 'ipv4';
    list.addSubnet(address, parseInt(prefix, 10), family);
  }
  return list;
}

function intFrom(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Tool registry. A tool is "enabled" (routable + a live hub tile) only if its
// upstream URL is set, so tools can be brought online one at a time without
// the gateway trying to proxy to a service that isn't running yet.
//
// `icon`       path under /public/icons to the tool's XP-style icon.
// `identity`   the tool needs to know who the user is: it receives the
//              X-Auth-* headers plus X-Gateway-Secret, which proves the request
//              came from the gateway and not from another container.
// `maxBodyMb`  request bodies above this are refused here, before the tool
//              has to receive (and spool to disk) the whole upload.
// `purgePath`  DELETE endpoint that removes all of the user's data in that
//              tool; called when an account is deleted.
// `timeoutMs`  upstream timeout. Cloudflare gives up after 100 s, so nothing
//              should be allowed to run longer than that.
function buildTools(env) {
  return [
    { slug: 'photo', name: 'Photo Editor', desc: 'Glitch & retro photo FX', icon: '/public/icons/tool-photo-editor.png', target: env.PHOTO_URL, maxBodyMb: 1 },
    { slug: 'promo', name: 'Promo Cards', desc: 'Release promo images', icon: '/public/icons/tool-promo-cards.png', target: env.PROMO_URL, maxBodyMb: 26 },
    { slug: 'beats', name: 'Beat Share', desc: 'Private audio cloud - share demos by link', icon: '/public/icons/tool-beat-share.png', target: env.BEATS_URL, identity: true, purgePath: '/api/me/data', maxBodyMb: intFrom(env.BEATS_MAX_UPLOAD_MB, 200) + 1 },
    { slug: 'midi', name: 'MIDI Chaos', desc: 'Generative MIDI sequencer - scales, engines & live preview', icon: '/public/icons/tool-midi-chaos.png', target: env.MIDI_URL, maxBodyMb: 1 },
    { slug: 'transcribe', name: 'Audio to MIDI (beta)', desc: 'Transcribe an audio clip into a MIDI file', icon: '/public/icons/tool-audio-to-midi.png', target: env.TRANSCRIBE_URL, identity: true, maxBodyMb: intFrom(env.TRANSCRIBE_MAX_UPLOAD_MB, 25) + 1 },
    { slug: 'analyzer', name: 'Audio Analyzer (beta)', desc: 'Get BPM and key, plus loudness & level metrics', icon: '/public/icons/tool-audio-analyzer.png', target: env.ANALYZER_URL, identity: true, maxBodyMb: intFrom(env.ANALYZER_MAX_UPLOAD_MB, 40) + 1, timeoutMs: 95_000 },
    { slug: 'tags', name: 'Audio Tag Editor', desc: 'ID3/WAV metadata, ISRC & album cover art', icon: '/public/icons/tool-tags.png', target: env.TAGS_URL, maxBodyMb: intFrom(env.TAGS_MAX_UPLOAD_MB, 100) + 16 },
    { slug: 'bgremove', name: 'Background Remover', desc: 'Cut a photo’s background out to transparent PNG', icon: '/public/icons/tool-bg-remove.png', target: env.BGREMOVE_URL, identity: true, maxBodyMb: intFrom(env.BGREMOVE_MAX_UPLOAD_MB, 15) + 1, timeoutMs: 95_000 },
  ];
}

function contentSecurityPolicy(analyticsOrigin) {
  const analytics = analyticsOrigin ? ` ${analyticsOrigin}` : '';
  // Every tool page has inline <script> blocks and style attributes, hence
  // 'unsafe-inline'. The policy still pins where scripts, requests, frames and
  // form posts may go, which is what limits the damage of an injection.
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${analytics}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${analytics}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');
}

function createApp(env = process.env) {
  const ACCOUNTS_URL = env.ACCOUNTS_URL || 'http://accounts:4100';
  const GATEWAY_SECRET = env.GATEWAY_SECRET;
  if (!GATEWAY_SECRET) throw new Error('GATEWAY_SECRET env var is required');
  const SHARED_DIR = env.SHARED_DIR || path.join(__dirname, 'shared');
  const PUBASSETS_DIR = env.PUBASSETS_DIR || path.join(__dirname, 'pubassets');
  const PUBLIC_DIR = path.join(__dirname, 'public');
  const FEEDBACK_DIR = env.FEEDBACK_DIR || path.join(__dirname, 'feedback');
  // Enable when the site is served through Cloudflare.
  const TRUST_CF_CONNECTING_IP = env.TRUST_CF_CONNECTING_IP === 'true';
  const cloudflare = blockListFrom(
    env.CLOUDFLARE_IP_RANGES ? env.CLOUDFLARE_IP_RANGES.split(',') : CLOUDFLARE_RANGES
  );
  const CSP = contentSecurityPolicy(env.ANALYTICS_ORIGIN ?? 'https://stats.drwncvnt.com');
  fs.mkdirSync(FEEDBACK_DIR, { recursive: true });

  const TOOLS = buildTools(env);
  const enabledTools = TOOLS.filter((t) => !!t.target);
  const sessions = new SessionStore({ accountsUrl: ACCOUNTS_URL, secret: GATEWAY_SECRET });

  const app = express();
  app.disable('x-powered-by');
  // Exactly one proxy (Nginx Proxy Manager) sits in front of the gateway.
  app.set('trust proxy', 1);
  app.use(cookieParser());

  // Behind Cloudflare, req.ip is a Cloudflare edge address that thousands of
  // unrelated visitors share, so rate limits keyed on it would be both too
  // loose (attacks spread over many edges) and too strict (strangers share a
  // bucket). CF-Connecting-IP carries the real visitor address.
  //
  // req.ip is the peer address Nginx Proxy Manager saw. The header is only
  // believed when that peer is a Cloudflare edge: someone connecting to the
  // origin directly can send any CF-Connecting-IP they like, but then their
  // own (non-Cloudflare) address is used instead.
  function fromCloudflare(ip) {
    if (!ip) return false;
    const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
    return net.isIPv4(v4) ? cloudflare.check(v4, 'ipv4') : net.isIPv6(ip) && cloudflare.check(ip, 'ipv6');
  }
  function clientIp(req) {
    if (TRUST_CF_CONNECTING_IP && fromCloudflare(req.ip)) {
      const cf = req.get('cf-connecting-ip');
      if (cf && net.isIP(cf)) return cf;
    }
    return req.ip;
  }

  // ---- Security headers ----------------------------------------------------
  // Set before anything else so they also cover proxied tool responses (the
  // proxy copies upstream headers onto the same response object, and no tool
  // sets these itself).
  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    next();
  });

  // ---- Cross-site request guard ----------------------------------------------
  // SameSite=Lax cookies are still sent on requests from sibling subdomains
  // (*.drwncvnt.com counts as the same "site"), so any state-changing request
  // must also prove it came from this exact origin.
  app.use((req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const fetchSite = req.get('sec-fetch-site');
    if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
      return res.status(403).json({ error: 'Cross-site request blocked.', detail: 'Cross-site request blocked.' });
    }
    const origin = req.get('origin');
    if (origin) {
      let originHost = null;
      try {
        originHost = new URL(origin).host;
      } catch {
        // "null" or garbage: treat as foreign.
      }
      if (!originHost || originHost !== req.get('host')) {
        return res.status(403).json({ error: 'Cross-site request blocked.', detail: 'Cross-site request blocked.' });
      }
    }
    next();
  });

  // ---- Rate limiting -------------------------------------------------------
  const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: clientIp,
    message: { error: 'Too many requests. Please slow down.', detail: 'Too many requests. Please slow down.' },
    skip: (req) => req.path.startsWith('/shared') || req.path.startsWith('/public'),
  });
  app.use(globalLimiter);

  // Only the credential-checking endpoints. /api/auth/me and logout are called
  // on every page load and must never lock a user out.
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 40,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: clientIp,
    message: { error: 'Too many authentication attempts. Please try again later.' },
  });
  app.post(['/api/auth/login', '/api/auth/register', '/api/auth/password', '/api/account/delete'], authLimiter);

  function claimsFromCookie(req) {
    const token = req.cookies[COOKIE_NAME];
    if (!token) return null;
    try {
      const claims = verify(token);
      return typeof claims.sid === 'string' ? claims : null;
    } catch {
      return null;
    }
  }

  // Resolves the cookie to the current user, or null when there is no valid,
  // unrevoked session. Throws only when accounts can't be reached.
  async function resolveSession(req) {
    const claims = claimsFromCookie(req);
    if (!claims) return null;
    const user = await sessions.lookup(claims.sid);
    if (!user || String(user.id) !== String(claims.sub)) return null;
    return { sub: String(user.id), username: user.username, plan: user.plan, sid: claims.sid };
  }

  // ---- Public routes -------------------------------------------------------

  // Shared design system (CSS, JS, and any shared assets). No secrets here, and
  // the login page needs it, so it stays public.
  //
  // No maxAge: these files change during active development, and a blind
  // time-based cache means a browser that fetched xp.css/platform-ui.js before
  // an edit keeps using the stale copy - for up to the maxAge window - even
  // though every page's HTML has already moved on to expect the new version,
  // producing exactly the "half old / half new" breakage that maxAge caused
  // once already. express.static still sends ETag/Last-Modified, so an
  // unchanged file is still served as a cheap 304 - we just stop trusting the
  // clock over the actual file content.
  express.static.mime.define({ 'image/jpeg': ['jfif'] });
  app.use('/shared', express.static(SHARED_DIR));

  // Public static assets (e.g. the aboba gif, tool icons) served to every tool.
  // Public so the login page and all tools can reference them without a
  // session. Same caching reasoning as /shared above.
  app.use('/public', express.static(PUBASSETS_DIR, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.jfif')) res.setHeader('Content-Type', 'image/jpeg');
    },
  }));

  // Logout and password changes revoke sessions in accounts; drop the cached
  // answers too so the revoked cookie stops working right away rather than
  // after the cache TTL.
  app.post('/api/auth/logout', (req, res, next) => {
    const claims = claimsFromCookie(req);
    if (claims) sessions.invalidate(claims.sid);
    next();
  });

  // Auth API is proxied to the accounts service. pathFilter keeps the original
  // path (/api/auth/login etc.) intact when forwarding. Path filters are
  // functions rather than strings everywhere, so http-proxy-middleware never
  // hands anything to its glob matcher (micromatch/braces) at runtime.
  app.use(
    createProxyMiddleware({
      target: ACCOUNTS_URL,
      changeOrigin: true,
      pathFilter: (p) => p === '/api/auth' || p.startsWith('/api/auth/'),
      proxyTimeout: 15000,
      on: {
        proxyReq: (proxyReq, req) => {
          for (const h of TRUSTED_HEADERS) proxyReq.removeHeader(h);
          proxyReq.setHeader('X-Client-IP', clientIp(req));
        },
        proxyRes: (proxyRes, req) => {
          if (req.path === '/api/auth/password' && proxyRes.statusCode === 200) {
            const claims = claimsFromCookie(req);
            if (claims) sessions.invalidateUser(claims.sub);
          }
        },
        error: (err, req, res) => {
          if (res.writableEnded || res.headersSent) return;
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Account service unavailable.' }));
        },
      },
    })
  );

  // Public tool registry for the hub to render tiles. Includes disabled tools so
  // they can show as "Soon".
  app.get('/api/tools', (req, res) => {
    res.json({
      tools: TOOLS.map((t) => ({
        slug: t.slug,
        name: t.name,
        desc: t.desc,
        icon: t.icon,
        enabled: !!t.target,
      })),
    });
  });

  app.get('/login', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));

  // Public share surface for the beats tool: a shared track can be listened to by
  // anyone who has the link, without a platform account. Only these exact paths
  // bypass the session gate, and the tokened ones still require a token that the
  // beats service itself verifies - the gateway just lets them reach it.
  function isPublicSharePath(req) {
    const p = req.path;
    if (p.split('/').includes('..') || p.includes('%')) return false;
    if (/^\/beats\/listen\/[A-Za-z0-9._-]+$/.test(p)) return true; // the listen page (token in path)
    const hasToken = typeof req.query.token === 'string' && req.query.token.length > 0;
    if (p === '/beats/api/public/track' && hasToken) return true;
    if (p.startsWith('/beats/api/stream/') && hasToken) return true;
    return false;
  }

  // ---- Session gate --------------------------------------------------------
  // Everything past this point requires a valid session. Browsers navigating to
  // a page get redirected to /login; API/asset requests get a 401.
  app.use(async (req, res, next) => {
    const publicShare = req.method === 'GET' && isPublicSharePath(req);
    let session = null;
    try {
      session = await resolveSession(req);
    } catch (err) {
      console.error('session lookup failed:', err.message);
      if (!publicShare) {
        return res.status(503).json({ error: 'Sign-in service is temporarily unavailable.', detail: 'Sign-in service is temporarily unavailable.' });
      }
    }
    if (session) {
      req.user = session;
      return next();
    }
    if (publicShare) {
      // No req.user is set, so the tool proxy injects no identity headers and
      // strips any client-supplied ones - the share token is the only authority.
      return next();
    }
    if (req.method === 'GET' && req.accepts('html')) {
      return res.redirect('/login');
    }
    return res.status(401).json({ error: 'Authentication required.', detail: 'Authentication required.' });
  });

  // ---- Protected routes ----------------------------------------------------

  app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

  // Feedback / bug reports from the Help menu. Each submission is written as its
  // own plain-text file under FEEDBACK_DIR (mounted to a host folder in compose),
  // in one consistent format, so they can just be read/grepped directly on disk
  // without standing up a database or admin UI for this.
  const feedbackLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: clientIp,
    message: { error: 'Too many submissions. Please wait a bit and try again.' },
  });
  const FEEDBACK_TYPES = new Set(['feedback', 'bug']);

  app.post('/api/feedback', feedbackLimiter, express.json({ limit: '32kb' }), (req, res) => {
    const { type, message } = req.body || {};
    if (!FEEDBACK_TYPES.has(type)) {
      return res.status(400).json({ error: 'Type must be "feedback" or "bug".' });
    }
    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Message is required.' });
    }
    if (message.length > 5000) {
      return res.status(400).json({ error: 'Message is too long (max 5000 characters).' });
    }

    const now = new Date();
    const safeUser = req.user.username.replace(/[^a-zA-Z0-9_-]/g, '_');
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const filename = `${stamp}_${safeUser}_${type}.txt`;

    const content =
      `Time: ${now.toISOString()}\n` +
      `User: ${req.user.username} (id ${req.user.sub})\n` +
      `Type: ${type}\n` +
      `${'-'.repeat(40)}\n` +
      `${message.trim()}\n`;

    fs.writeFile(path.join(FEEDBACK_DIR, filename), content, (err) => {
      if (err) {
        console.error('Failed to write feedback:', err);
        return res.status(500).json({ error: 'Could not save your submission. Please try again.' });
      }
      res.status(201).json({ ok: true });
    });
  });

  function identityHeaders(user) {
    return {
      'X-Auth-User-Id': String(user.sub),
      'X-Auth-Username': user.username,
      'X-Gateway-Secret': GATEWAY_SECRET,
    };
  }

  async function accountsInternal(pathname, init = {}) {
    return fetch(`${ACCOUNTS_URL}${pathname}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-gateway-secret': GATEWAY_SECRET, ...(init.headers || {}) },
      signal: AbortSignal.timeout(15000),
    });
  }

  // Account deletion: confirm the password, have every tool that stores user
  // data delete it, then delete the account itself. If any tool fails the
  // account is kept, so the user can retry instead of being left with orphaned
  // data they can no longer reach.
  app.post('/api/account/delete', express.json({ limit: '8kb' }), async (req, res) => {
    const password = req.body?.password;
    if (typeof password !== 'string' || !password) {
      return res.status(400).json({ error: 'Enter your password to confirm.' });
    }
    try {
      const check = await accountsInternal(`/internal/users/${encodeURIComponent(req.user.sub)}/verify-password`, {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      if (check.status !== 204) {
        const body = await check.json().catch(() => ({}));
        return res.status(check.status >= 500 ? 502 : check.status).json({ error: body.error || 'Could not verify your password.' });
      }

      for (const tool of enabledTools.filter((t) => t.purgePath)) {
        const purge = await fetch(`${tool.target}${tool.purgePath}`, {
          method: 'DELETE',
          headers: identityHeaders(req.user),
          signal: AbortSignal.timeout(60000),
        });
        if (!purge.ok) {
          console.error(`account delete: ${tool.slug} purge failed with HTTP ${purge.status}`);
          return res.status(502).json({ error: `Could not delete your data in ${tool.name}. Your account was not deleted, please try again.` });
        }
      }

      const del = await accountsInternal(`/internal/users/${encodeURIComponent(req.user.sub)}`, { method: 'DELETE' });
      if (del.status !== 204) throw new Error(`accounts delete failed with HTTP ${del.status}`);
    } catch (err) {
      console.error('account delete failed:', err.message);
      return res.status(502).json({ error: 'Could not delete your account right now. Please try again.' });
    }
    sessions.invalidateUser(req.user.sub);
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  });

  // Reverse-proxy each enabled tool at /<slug>/*, stripping the prefix so the
  // upstream service can keep serving from its own root.
  for (const tool of enabledTools) {
    const prefix = `/${tool.slug}`;
    const maxBodyBytes = tool.maxBodyMb * MB;
    // Redirect ONLY the bare prefix (no trailing slash) to the slash form, so
    // relative asset URLs in the tool's HTML resolve under /<slug>/ instead of
    // the site root. Exact-path check avoids also catching "/<slug>/..." - with
    // Express's default loose routing, app.get('/slug') would match '/slug/' too.
    app.use((req, res, next) => {
      if (req.path === prefix) return res.redirect(301, `${prefix}/`);
      next();
    });
    // Refuse oversized bodies up front. Browsers always send Content-Length
    // for uploads, so a chunked body without one is refused too: its size
    // can't be checked before the tool has already buffered it.
    app.use(prefix, (req, res, next) => {
      if (SAFE_METHODS.has(req.method)) return next();
      const len = req.get('content-length');
      if (len === undefined) {
        if (req.get('transfer-encoding')) {
          return res.status(411).json({ error: 'Content-Length required.', detail: 'Content-Length required.' });
        }
        return next();
      }
      if (!/^\d+$/.test(len) || Number(len) > maxBodyBytes) {
        const msg = `Upload is too large for ${tool.name} (max ${tool.maxBodyMb} MB).`;
        return res.status(413).json({ error: msg, detail: msg });
      }
      next();
    });
    app.use(
      createProxyMiddleware({
        target: tool.target,
        changeOrigin: true,
        pathFilter: (p) => p === prefix || p.startsWith(`${prefix}/`),
        pathRewrite: { [`^${prefix}`]: '' },
        // No ws: WebSocket upgrades bypass Express middleware (including the
        // session gate), and no tool needs them. Leaving it off keeps every path
        // authenticated. Add a gated upgrade handler if a tool ever needs WS.
        proxyTimeout: tool.timeoutMs || 60000,
        on: {
          proxyReq: (proxyReq, req) => {
            // Strip every gateway-only header first so a browser can never
            // spoof another user's identity - only the gateway sets these.
            for (const h of TRUSTED_HEADERS) proxyReq.removeHeader(h);
            // Tools don't use cookies; not forwarding them keeps the session
            // token away from every tool container.
            proxyReq.removeHeader('cookie');
            if (req.user && tool.identity) {
              for (const [k, v] of Object.entries(identityHeaders(req.user))) proxyReq.setHeader(k, v);
            }
          },
          error: (err, req, res) => {
            if (res.writableEnded || res.headersSent) return;
            res.writeHead(502, { 'Content-Type': 'application/json' });
            const msg = `${tool.name} is temporarily unavailable.`;
            res.end(JSON.stringify({ error: msg, detail: msg }));
          },
        },
      })
    );
  }

  app.locals.enabledTools = enabledTools;
  app.locals.clientIp = clientIp;
  return app;
}

module.exports = { createApp };
