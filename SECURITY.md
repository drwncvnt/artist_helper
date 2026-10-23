# Security

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Instead, report them
privately via GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository, or by contacting the maintainer directly. We'll acknowledge
receipt and work with you on a fix and disclosure timeline.

## Security model

The design intentionally centralizes trust in two places - the **gateway** and the
**accounts** service - so the individual tools stay simple.

- **Single front door.** Only the gateway is published to the network. `accounts`,
  the database, and every tool communicate over an internal Docker network and are
  never directly reachable, so the gateway's session gate cannot be bypassed.
- **Session gate.** Every request except the login page and shared static assets
  requires a valid, signed session cookie (JWT, HS256 only, HttpOnly, SameSite=Lax,
  and Secure in production). Unauthenticated page requests redirect to `/login`;
  API/asset requests get `401`.
- **Revocable sessions.** Each login creates a row in the `sessions` table and the
  cookie only carries its id. The gateway checks that the session still exists
  (cached for up to 30 seconds), so logout, a password change (which signs out every
  other device) and account deletion take effect immediately.
- **Identity forwarding, spoof-proof.** The gateway forwards the authenticated user
  to the tools that need it via `X-Auth-User-Id` / `X-Auth-Username`, together with
  `X-Gateway-Secret`, and **strips any client-supplied copies first**. Tools reject
  identity headers that don't carry the secret, so neither a browser nor another
  container on the network can impersonate a user. Cookies are never forwarded to
  tools.
- **Network segmentation.** Tools share a network with the gateway only; the
  accounts service and the database sit on separate internal networks that tools
  cannot reach.
- **Cross-site requests.** Any state-changing request must come from the gateway's
  own origin (checked via `Origin` / `Sec-Fetch-Site`). This also blocks requests
  from sibling subdomains, which SameSite=Lax alone would allow.
- **Security headers.** Content-Security-Policy (including `frame-ancestors 'self'`),
  HSTS, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` and
  `Permissions-Policy` are set on every response, including proxied tool pages.
- **Passwords.** Hashed with bcrypt (cost 12) in the accounts service. Login compares
  against a real dummy hash for unknown users and returns one uniform error, to avoid
  revealing which usernames exist. Usernames are unique case-insensitively. Email is
  optional and deliberately not unique, so registration can't be used to check
  whether an address has an account.
- **Rate limiting.** Login is limited per client address and per username (failed
  attempts only), registration per client address. Behind Cloudflare the real visitor
  address comes from `CF-Connecting-IP`, which is only trusted when the request
  actually arrived from a Cloudflare edge address.
- **Input validation.** Usernames, emails, and passwords are validated at the
  accounts boundary; all database access uses parameterized queries.
- **Uploads.** The gateway refuses bodies over each tool's limit before they are
  forwarded. Every tool stores uploads under server-generated names (the client's
  file name is never used as a path), restricts file types, and caps size while
  streaming. Image tools only let Pillow's JPEG/PNG/WebP decoders see uploads and
  cap decoded size. Beat Share enforces a per-account storage quota and refuses
  uploads when the disk is close to full; private tracks are only streamable by
  their owner or through a share link for that exact track.
- **Containers.** Every service runs as an unprivileged user with
  `no-new-privileges`, no Linux capabilities and a read-only root filesystem.
  Application code is owned by root, so a bug in a tool can't rewrite the tool.

## Secrets

No secrets are committed. All secrets (`POSTGRES_PASSWORD`, `JWT_SECRET`,
`SIGNING_SECRET`, `GATEWAY_SECRET`) are supplied at runtime through `.env`, which is
git-ignored. Only
`.env.example` (with empty placeholders) is tracked. Generate strong values with
`openssl rand -hex 32`.

## Deployment notes

- Terminate TLS in front of the gateway and set `COOKIE_SECURE=true`.
- Behind Cloudflare, set `TRUST_CF_CONNECTING_IP=true` so rate limits see real
  visitor addresses.
- Keep the internal services unpublished (the provided `docker-compose.yml` already
  publishes only the gateway).
- To sign everyone out, empty the `sessions` table (or rotate `JWT_SECRET`).
