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
  requires a valid, signed session cookie (JWT, HttpOnly, SameSite=Lax, and Secure
  in production). Unauthenticated page requests redirect to `/login`; API/asset
  requests get `401`.
- **Identity forwarding, spoof-proof.** The gateway forwards the authenticated user
  to each tool via `X-Auth-User-Id` / `X-Auth-Username` headers, and **strips any
  client-supplied copies first**, so a browser cannot forge another user's identity.
  Tools trust these headers only because they can only be reached through the gateway.
- **Passwords.** Hashed with bcrypt (cost 12) in the accounts service. Login uses a
  constant-time comparison and a uniform error for both wrong password and unknown
  user, to avoid revealing which usernames exist.
- **Rate limiting.** Login and registration are rate-limited per client IP to blunt
  brute-force and credential-stuffing attempts.
- **Input validation.** Usernames, emails, and passwords are validated at the
  accounts boundary; all database access uses parameterized queries.
- **Uploads.** Beat Share enforces an upload size cap (default 200 MB) while
  streaming, restricts file types by extension, and resolves stored paths safely to
  prevent directory traversal.

## Secrets

No secrets are committed. All secrets (`POSTGRES_PASSWORD`, `JWT_SECRET`,
`SIGNING_SECRET`) are supplied at runtime through `.env`, which is git-ignored. Only
`.env.example` (with empty placeholders) is tracked. Generate strong values with
`openssl rand -hex 32`.

## Deployment notes

- Terminate TLS in front of the gateway and set `COOKIE_SECURE=true`.
- Keep the internal services unpublished (the provided `docker-compose.yml` already
  publishes only the gateway).
- Rotate `JWT_SECRET` to invalidate all existing sessions if needed.
