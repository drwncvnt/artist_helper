# Contributing

Thanks for your interest in the drwncvnt platform.

## Development

The whole stack runs with Docker Compose:

```bash
cp .env.example .env    # fill in secrets (openssl rand -hex 32)
docker compose up -d --build
```

Open <http://localhost:4000>.

Each part is independent:

- **gateway/** and **accounts/** - Node/Express. Rebuild with
  `docker compose up -d --build gateway accounts`.
- **photo/** - static files; just rebuild the `photo` image.
- **promo/**, **midi/** - Flask apps.
- **beats/** - FastAPI backend + Vite/React frontend, built into one image.

## Adding a tool

1. Add a directory with its own `Dockerfile` that serves the tool from its container
   root, using relative asset paths (or `/shared/...` for shared assets) so it works
   when proxied under `/<slug>/`.
2. Add the service to `docker-compose.yml`.
3. Register it in the gateway's `TOOLS` list and set its `*_URL` env var.
4. If the tool needs to know who the user is, mark it `identity: true` in `TOOLS`
   and read the `X-Auth-User-Id` / `X-Auth-Username` headers the gateway injects,
   accepting them only when `X-Gateway-Secret` matches the `GATEWAY_SECRET` env var
   (compare with `hmac.compare_digest`). Do **not** add a separate login. If it
   stores per-user data, give it a `purgePath` endpoint so account deletion can
   remove that data.
5. Never build a file path from a client-supplied file name; generate the name on
   the server and only reuse the client's extension after checking it against an
   allowlist.

## Tests

```bash
cd gateway && npm ci && npm test
docker run --rm -v "$PWD/beats:/src" -w /src python:3.12-slim \
  sh -c "pip install -q -r backend/requirements.txt pytest httpx && python -m pytest tests"
docker run --rm -v "$PWD/tags:/src" -w /src python:3.11-slim \
  sh -c "pip install -q -r backend/requirements.txt pytest httpx && python -m pytest tests"
```

The same tests, plus dependency audits, run in GitHub Actions on every push.

## Guidelines

- Keep tools behind the gateway; never publish their ports directly.
- Never commit secrets. Use `.env` (git-ignored) and add any new variables to
  `.env.example` with an empty placeholder and a comment.
- Match the existing shared design system (`shared/xp.css`) for any new UI.
- Report security issues privately (see [SECURITY.md](SECURITY.md)), not as public
  issues or PRs.
