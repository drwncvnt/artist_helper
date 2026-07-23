const fs = require('fs');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { verify, COOKIE_NAME } = require('./jwt');

const PORT = process.env.PORT || 4000;
const ACCOUNTS_URL = process.env.ACCOUNTS_URL || 'http://accounts:4100';
const SHARED_DIR = process.env.SHARED_DIR || path.join(__dirname, 'shared');
const PUBASSETS_DIR = process.env.PUBASSETS_DIR || path.join(__dirname, 'pubassets');
const PUBLIC_DIR = path.join(__dirname, 'public');
const FEEDBACK_DIR = process.env.FEEDBACK_DIR || path.join(__dirname, 'feedback');
fs.mkdirSync(FEEDBACK_DIR, { recursive: true });

// Tool registry. A tool is "enabled" (routable + a live hub tile) only if its
// upstream URL env is set, so tools can be brought online one at a time without
// the gateway trying to proxy to a service that isn't running yet.
const TOOLS = [
  { slug: 'photo', name: 'Photo Editor', desc: 'Glitch & retro photo FX', icon: 'PE', target: process.env.PHOTO_URL },
  { slug: 'promo', name: 'Promo Cards', desc: 'Release promo images', icon: 'PC', target: process.env.PROMO_URL },
  { slug: 'beats', name: 'Beat Share', desc: 'Private audio cloud - share demos by link', icon: 'BS', target: process.env.BEATS_URL },
  { slug: 'midi', name: 'MIDI Chaos', desc: 'Generative MIDI sequencer - scales, engines & live preview', icon: 'MC', target: process.env.MIDI_URL },
  { slug: 'transcribe', name: 'Audio to MIDI (beta)', desc: 'Transcribe an audio clip into a MIDI file', icon: 'AM', target: process.env.TRANSCRIBE_URL },
];
const enabledTools = TOOLS.filter((t) => !!t.target);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(cookieParser());

function readSession(req) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return null;
  try {
    return verify(token);
  } catch {
    return null;
  }
}

// ---- Public routes -------------------------------------------------------

// Shared design system (CSS, JS, and any shared assets). No secrets here, and
// the login page needs it, so it stays public.
app.use('/shared', express.static(SHARED_DIR, { maxAge: '1h' }));

// Public static assets (e.g. the aboba gif) served to every tool. Public so the
// login page and all tools can reference them without a session.
app.use('/public', express.static(PUBASSETS_DIR, { maxAge: '1h' }));

// Auth API is proxied to the accounts service. pathFilter keeps the original
// path (/api/auth/login etc.) intact when forwarding.
app.use(
  createProxyMiddleware({
    target: ACCOUNTS_URL,
    changeOrigin: true,
    pathFilter: '/api/auth',
    proxyTimeout: 15000,
    on: {
      error: (err, req, res) => {
        if (res.writableEnded) return;
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
  if (p.startsWith('/beats/listen/')) return true; // the listen page (token in path)
  const hasToken = typeof req.query.token === 'string' && req.query.token.length > 0;
  if (p === '/beats/api/public/track' && hasToken) return true;
  if (p.startsWith('/beats/api/stream/') && hasToken) return true;
  return false;
}

// ---- Session gate --------------------------------------------------------
// Everything past this point requires a valid session. Browsers navigating to
// a page get redirected to /login; API/asset requests get a 401.
app.use((req, res, next) => {
  const claims = readSession(req);
  if (claims) {
    req.user = claims;
    return next();
  }
  if (req.method === 'GET' && isPublicSharePath(req)) {
    // No req.user is set, so the tool proxy injects no identity headers and
    // strips any client-supplied ones - the share token is the only authority.
    return next();
  }
  if (req.method === 'GET' && req.accepts('html')) {
    return res.redirect('/login');
  }
  return res.status(401).json({ error: 'Authentication required.' });
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

// Reverse-proxy each enabled tool at /<slug>/*, stripping the prefix so the
// upstream service can keep serving from its own root.
for (const tool of enabledTools) {
  const prefix = `/${tool.slug}`;
  // Redirect ONLY the bare prefix (no trailing slash) to the slash form, so
  // relative asset URLs in the tool's HTML resolve under /<slug>/ instead of
  // the site root. Exact-path check avoids also catching "/<slug>/..." - with
  // Express's default loose routing, app.get('/slug') would match '/slug/' too.
  app.use((req, res, next) => {
    if (req.path === prefix) return res.redirect(301, `${prefix}/`);
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
      proxyTimeout: 60000,
      on: {
        proxyReq: (proxyReq, req) => {
          // Pass the authenticated identity to the upstream tool via trusted
          // headers. Strip any client-supplied X-Auth-* first so a browser can
          // never spoof another user's identity - only the gateway sets these.
          proxyReq.removeHeader('x-auth-user-id');
          proxyReq.removeHeader('x-auth-username');
          if (req.user) {
            proxyReq.setHeader('X-Auth-User-Id', String(req.user.sub));
            proxyReq.setHeader('X-Auth-Username', req.user.username);
          }
        },
        error: (err, req, res) => {
          if (res.writableEnded) return;
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end(`${tool.name} is temporarily unavailable.`);
        },
      },
    })
  );
}

app.listen(PORT, () => {
  console.log(`gateway listening on ${PORT}`);
  console.log(`enabled tools: ${enabledTools.map((t) => t.slug).join(', ') || '(none)'}`);
});
