# drwncvnt platform - https://helper.drwncvnt.com/

A suite of **creative tools for artists, producers, and designers**, unified behind one account. Sign in once, every tool just works.

The platform bundles eight tools into a cohesive retro Windows XP workstation:

| Tool | What it does | Stack |
|------|--------------|-------|
| **Photo Editor** | Real-time glitch / retro / VHS / datamosh photo & video FX | Static + WebGL2 |
| **Promo Cards** | Generate 1080×1920 release promo cards from a square cover | Flask + Pillow |
| **Beat Share** | Private audio cloud - keep demos/beats private or public, share any track by link | FastAPI + React |
| **MIDI Chaos** | Generative MIDI sequencer - scales, engines (random-walk, euclidean, arpeggio, chaos), density, swing & seed; preview in-browser, download `.mid` | Flask + mido + Web Audio |
| **Audio to MIDI** | Transcribe an audio clip to MIDI at a chosen tempo (optionally quantized). Capped at two concurrent analyses; extra requests wait in a queue | FastAPI + basic-pitch |
| **Audio Analyzer** | Extract BPM, musical key, LUFS loudness, and dynamic range metrics from audio files | FastAPI + librosa + pyloudnorm |
| **Audio Tag Editor** | Inspect and edit ID3v2, WAV, FLAC, and M4A metadata, ISRC codes, BPM, key, and embed album cover artwork | FastAPI + mutagen + Pillow |
| **Background Remover** | Cut a photo’s background out to transparent PNG with a 2-slot concurrency queue and memory bounds | FastAPI + rembg (ONNX) |

---

## Architecture

Everything sits behind a single **gateway** that is the only service exposed to the
outside world. The gateway verifies the session and reverse-proxies each tool at a
sub-path; the tools themselves are never reachable directly.

```
                          ┌──────────────────────────────────────────────────────────┐
   browser ──HTTPS──▶     │                     gateway (public)                     │
                          │  • session gate (JWT cookie)                             │
                          │  • reverse proxy /photo /promo /beats /tags /bgremove …  │
                          │  • rate limiting & abuse prevention                      │
                          │  • injects trusted X-Auth-* identity                     │
                          └──┬──────┬──────┬──────┬──────┬──────┬──────┬──────┬──────┘
                             │      │      │      │      │      │      │      │
                        accounts  photo  promo  beats  midi  transcribe tags analyzer bgremove
                             │
                          Postgres
```

- **gateway** (Node/Express) - Single front door. Gates every request on a signed session cookie, serves the hub + login pages, and proxies each tool. It injects the authenticated identity into upstream requests as `X-Auth-User-Id` / `X-Auth-Username`, stripping any client-supplied copies so identity cannot be forged.
- **accounts** (Node/Express + Postgres) - The only service that owns users and passwords. Registers/authenticates users (bcrypt, factor 12) and issues the JWT session cookie shared across the whole platform.
- **Microservice Tools** - Each trusts the gateway-injected identity instead of running its own login. Heavy compute services (`bgremove`, `transcribe`, `analyzer`) run bounded queues and thread pools to prevent CPU/RAM starvation.

A tool only appears on the Hub (and becomes routable) when its upstream URL is configured in the gateway environment, so tools can be enabled or disabled independently.

---

## Quick start

Requires Docker + Docker Compose.

```bash
git clone <this-repo> drwncvnt-platform
cd drwncvnt-platform
cp .env.example .env

# Fill in the secrets in .env - generate each with:
#   openssl rand -hex 32
# (POSTGRES_PASSWORD, JWT_SECRET, SIGNING_SECRET, GATEWAY_SECRET)

docker compose up -d --build
```

Then open <http://localhost:4000>. Create an account and you land on the hub with all the tools.

For production deployment, terminate TLS in front of the gateway (e.g. reverse proxy / Let’s Encrypt) and set `COOKIE_SECURE=true` in `.env`. Behind Cloudflare, also set `TRUST_CF_CONNECTING_IP=true`.

---

## Configuration

All configuration is via `.env` (see `.env.example` for the complete list):

| Variable | Purpose | Default |
|----------|---------|---------|
| `POSTGRES_PASSWORD` | Platform database password | *(required)* |
| `JWT_SECRET` | Signs the shared session cookie (gateway + accounts) | *(required)* |
| `SIGNING_SECRET` | Signs time-limited track share links in Beat Share | *(required)* |
| `GATEWAY_SECRET` | Proves to accounts and the tools that a request came through the gateway | *(required)* |
| `COOKIE_SECURE` | `true` for any HTTPS deployment; `false` for local HTTP | `false` |
| `TRUST_CF_CONNECTING_IP` | `true` behind Cloudflare, so rate limits use the real visitor address | `false` |
| `SESSION_TTL_SECONDS` | Session lifetime in seconds | `2592000` (30 days) |
| `GATEWAY_PORT` | Host port the gateway is published on | `4000` |
| `BEATS_MAX_UPLOAD_MB` | Upload cap for Beat Share (MB). Cloudflare Free/Pro reject bodies over 100 MB | `200` |
| `BEATS_USER_QUOTA_MB` | Total Beat Share storage per account (MB) | `1024` |
| `BEATS_MIN_FREE_DISK_MB` | Beat Share refuses uploads below this much free disk (MB) | `10240` |
| `TAGS_MAX_UPLOAD_MB` | Upload cap for Audio Tag Editor (MB) | `100` |
| `TRANSCRIBE_MAX_UPLOAD_MB` | Upload cap for Audio to MIDI (MB) | `25` |
| `TRANSCRIBE_MAX_DURATION_SECONDS` | Clip length cap for Audio to MIDI (sec) | `60` |
| `ANALYZER_MAX_UPLOAD_MB` | Upload cap for Audio Analyzer (MB) | `40` |
| `ANALYZER_MAX_DURATION_SECONDS` | Clip length cap for Audio Analyzer (sec) | `300` |
| `BGREMOVE_MODEL` | Segmentation model name | `isnet-general-use` |
| `BGREMOVE_MAX_UPLOAD_MB` | Upload cap for Background Remover (MB) | `15` |
| `BGREMOVE_MAX_CONCURRENT_JOBS` | Max concurrent ONNX inferences | `2` |
| `BGREMOVE_MAX_QUEUE_WAITING` | Max waiters before fast rejection | `20` |

---

## Repository layout

```
gateway/    single public entry point (session gate + reverse proxy + hub UI)
accounts/   central account & session service (Postgres + bcrypt)
shared/     shared design system (xp.css, platform-ui.js) used by all tools
public/     public assets, tool icons, and desktop wallpaper (img.jfif)
photo/      Photo Editor (static WebGL2 app)
promo/      Promo Cards (Flask + Pillow)
beats/      Beat Share (FastAPI backend + React frontend)
midi/       MIDI Chaos (Flask + mido + Web Audio sequencer)
transcribe/ Audio to MIDI (FastAPI + basic-pitch; 2-worker queue)
analyzer/   Audio Analyzer (FastAPI + librosa; BPM, key, loudness metrics)
tags/       Audio Tag Editor (FastAPI + mutagen; ID3/WAV/FLAC/M4A metadata & cover art)
bgremove/   Background Remover (FastAPI + rembg ONNX; concurrency bounded)
docker-compose.yml
.github/    CI (tests + dependency audits) and Dependabot config
```

Tests live in `gateway/test/`, `beats/tests/` and `tags/tests/`; see [CONTRIBUTING.md](CONTRIBUTING.md) for how to run them.

---

## Design & Experience

The platform features an authentic **Red Windows XP (Burgundy / Crimson Royale)** theme defined in `shared/xp.css`:
- **Desktop**: Fullscreen desktop wallpaper (`/public/img.jfif`) over a rich burgundy backdrop.
- **Window Chrome**: Classic 3D-beveled window frames, titlebars with ruby-to-coral gradients, close button hover highlights (`#e62839`), and classic 3D scrollbars.
- **Form Controls**: Retro range sliders (`input[type="range"]`), sunken dashed Drag & Drop upload zones (`.upload-zone`), and animated striped progress bars (`.xp-progress`).
- **Interactive Feedback**: Windows XP balloon-tip toast notifications (`window.platformToast`) for status and copy confirmations.

---

## Security & Resource Protection

- **Single Entry Point**: Only port 4000 (gateway) is published. Tools share a network with the gateway only; accounts and the database live on separate internal networks.
- **Revocable sessions**: Logout, password changes and account deletion invalidate session cookies immediately.
- **Spoof-proof identity**: Tools only accept gateway identity headers together with a shared gateway secret; cookies never reach the tools.
- **Cross-site protection**: State-changing requests must come from the site's own origin, and every response carries CSP, HSTS and anti-framing headers.
- **Multi-tier Rate Limiting**:
  - Gateway global limiter (`300 req/min` per visitor address, read from Cloudflare's `CF-Connecting-IP` when the request really came from Cloudflare).
  - Credential limiters on login and registration only (never on session checks), plus a per-username limit on failed logins.
  - Per-user caps in the heavy tools so one account can't occupy every queue slot.
- **Resource caps**: Memory and CPU limits on every container, per-account storage quota and a free-disk floor in Beat Share, and per-tool upload limits enforced at the gateway.
- **Safe Uploads**: Server-generated file names everywhere, streaming size caps, Pillow restricted to JPEG/PNG/WebP decoders with a 25-megapixel limit, and duration limits for audio.
- **Hardened containers**: Non-root users, read-only root filesystems, no Linux capabilities, `no-new-privileges`.
- **Accounts**: Change password or delete your account (including your Beat Share uploads) from **File > Account settings** in the hub.

See [SECURITY.md](SECURITY.md) for the full security model and vulnerability reporting.

---

## License

[MIT](LICENSE).
