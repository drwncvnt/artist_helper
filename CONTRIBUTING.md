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
4. If the tool needs to know who the user is, read the `X-Auth-User-Id` /
   `X-Auth-Username` headers the gateway injects - do **not** add a separate login.

## Guidelines

- Keep tools behind the gateway; never publish their ports directly.
- Never commit secrets. Use `.env` (git-ignored) and add any new variables to
  `.env.example` with an empty placeholder and a comment.
- Match the existing shared design system (`shared/xp.css`) for any new UI.
- Report security issues privately (see [SECURITY.md](SECURITY.md)), not as public
  issues or PRs.
