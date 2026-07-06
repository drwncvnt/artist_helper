# drwncvnt platform - https://helper.drwncvnt.com/

A small suite of **creative tools for artists**, unified behind one account. Sign in once, every tool just works.

The platform bundles four tools that used to be separate apps:

| Tool | What it does | Stack |
|------|--------------|-------|
| **Photo Editor** | Real-time glitch / retro / VHS / datamosh photo & video FX (WebGL2) | Static + WebGL |
| **Promo Cards** | Generate 1080×1920 release promo cards from a cover | Flask + Pillow |
| **Beat Share** | Private audio cloud - keep demos/beats private or public, share any track by link (no account needed to listen) | FastAPI + React |
| **MIDI Chaos** | Generate algorithmic IDM MIDI sequences | Flask + mido |



## Architecture

Everything sits behind a single **gateway** that is the only service exposed to the
outside world. The gateway verifies the session and reverse-proxies each tool at a
sub-path; the tools themselves are never reachable directly.

```
                          ┌─────────────────────────────────────────┐
   browser ──HTTPS──▶ gateway (public)                               │
                          │  • session gate (JWT cookie)             │
                          │  • reverse proxy /photo /promo /beats …  │
                          │  • injects trusted X-Auth-* identity     │
                          └───┬───────┬───────┬───────┬───────┬──────┘
                              │       │       │       │       │
                         accounts   photo   promo   beats   midi   (internal only)
                              │
                          Postgres
```

- **gateway** (Node/Express) - single front door. Gates every request on a signed
  session cookie, serves the hub + login pages, and proxies each tool. It injects
  the authenticated identity into upstream requests as `X-Auth-User-Id` /
  `X-Auth-Username`, stripping any client-supplied copies so identity can’t be forged.
- **accounts** (Node/Express + Postgres) - the only service that owns users and
  passwords. Registers/authenticates users (bcrypt) and issues the JWT session cookie
  shared across the whole platform. Holds the `plan` field for future subscriptions.
- **photo / promo / beats / midi** - the tools. Each was ported from its original
  standalone app with its own login removed; they trust the gateway-injected identity.

A tool only appears (and becomes routable) when its upstream URL is configured in the
gateway, so tools can be enabled one at a time.

## Quick start

Requires Docker + Docker Compose.

```bash
git clone <this-repo> drwncvnt-platform
cd drwncvnt-platform
cp .env.example .env

# Fill in the secrets in .env - generate each with:
#   openssl rand -hex 32
# POSTGRES_PASSWORD, JWT_SECRET, SIGNING_SECRET

docker compose up -d --build
```

Then open <http://localhost:4000>. Create an account and you land on the hub with all
four tools.

For a real deployment, terminate TLS in front of the gateway (e.g. a reverse proxy /
Let’s Encrypt) and set `COOKIE_SECURE=true` in `.env`.

## Configuration

All configuration is via `.env` (see `.env.example` for the full list):

| Variable | Purpose |
|----------|---------|
| `POSTGRES_PASSWORD` | Platform database password |
| `JWT_SECRET` | Signs the shared session cookie (gateway + accounts) |
| `SIGNING_SECRET` | Signs time-limited track share links in Beat Share |
| `COOKIE_SECURE` | `true` for any HTTPS deployment; `false` only for local HTTP |
| `SESSION_TTL_SECONDS` | Session lifetime (default 30 days) |
| `BEATS_MAX_UPLOAD_MB` | Upload cap for Beat Share (default 200) |
| `GATEWAY_PORT` | Host port the gateway is published on (default 4000) |

## Repository layout

```
gateway/    single public entry point (session gate + reverse proxy + hub UI)
accounts/   central account & session service (Postgres)
shared/     shared design system (xp.css) used by the hub and every tool
photo/      Photo Editor  (static WebGL app)
promo/      Promo Cards   (Flask)
beats/      Beat Share    (FastAPI backend + React frontend, one container)
midi/       MIDI Chaos    (Flask)
docker-compose.yml
```

## Design

The whole platform shares one **“improved Windows XP / classic Paint”** theme, defined
once in `shared/xp.css` (window chrome, buttons, fields, dialogs, the hub launcher) and
reused everywhere so four different tools read as one product.

## Security

Security-sensitive behavior (session gating, identity forwarding, password hashing,
rate limiting, service isolation) is described in [SECURITY.md](SECURITY.md). Please
report vulnerabilities as described there rather than in a public issue.

## License

[MIT](LICENSE).
