# Avalon

A small, real-time Avalon game for one host display and 6–10 player phones.
Game state is intentionally in memory: run exactly one application worker, and
expect an application restart to end active games.

## Security model

- Only the host display can create and control games.
- Creating a game requires `HOST_ADMIN_PASSWORD`.
- A successful creation returns a separate random host capability, retained in
  the host browser's session storage for reconnects.
- Players receive random reconnect capabilities but never host authority.
- Room codes are six cryptographically generated characters.
- Production refuses to start without explicit secrets and an HTTPS public URL.
- `/dev` and `/debug` are absent in production.
- The container publishes only to host loopback; public ingress should be an
  outbound tunnel such as Tailscale Funnel.

This is defense in depth for a hobby service, not a guarantee against every
denial-of-service attack. Keep the VM isolated from other home-network systems.

## Local development

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
HOST_ADMIN_PASSWORD=local-test-password .venv/bin/python server.py
```

Open `http://127.0.0.1:5001/host`. Development defaults to same-origin
WebSockets and uses an ephemeral Flask secret on each start. Development-only
routes require `ENABLE_DEV_ROUTES=true` and are still forbidden in production.

Run tests:

```bash
.venv/bin/pytest -q
```

## Production configuration

Copy the template without committing the result:

```bash
cp .env.example .env
python3 -c 'import secrets; print(secrets.token_hex(32))'
python3 -c 'import secrets; print(secrets.token_urlsafe(24))'
chmod 600 .env
```

Put the first output in `SECRET_KEY` and use a different value for
`HOST_ADMIN_PASSWORD`. Once Tailscale gives the VM its DNS name, set both
`PUBLIC_BASE_URL` and `PUBLIC_ORIGIN` to the exact HTTPS URL, with no trailing
slash. Do not quote values in `.env` unless the quotes are intended to be part
of the value.

## Build and verify without publishing

```bash
sudo docker compose config
sudo docker compose build --pull
sudo docker compose up -d
sudo docker compose ps
curl --fail http://127.0.0.1:5001/healthz
```

The expected health response is `{"status":"ok"}`. Port 5001 must not be
reachable through the VM's LAN address because Compose binds it to
`127.0.0.1` only.

Inspect logs without printing `.env`:

```bash
sudo docker compose logs --tail=100 avalon
```

## Tailscale Funnel (only after local verification)

```bash
sudo tailscale funnel --bg 5001
tailscale funnel status
```

Funnel terminates public HTTPS and proxies to `127.0.0.1:5001`. Do not create
an Xfinity port forward. Stop public access with:

```bash
sudo tailscale funnel reset
```

## Updating and rollback

Before updating, record the current commit:

```bash
git rev-parse HEAD
git pull --ff-only
sudo docker compose build --pull
sudo docker compose up -d
curl --fail http://127.0.0.1:5001/healthz
```

If verification fails, reset Funnel first, then check out the recorded commit,
rebuild, and restart. A restart clears active games, so update between sessions.

## Operational notes

- Never scale Gunicorn above one worker while state remains in memory.
- Rotate both production secrets after suspected disclosure.
- Host capabilities live only until the process restarts or the game ends.
- Keep Ubuntu, Docker, Tailscale, and Python dependencies patched.
- Back up source/configuration, not transient game state. Never commit `.env`.
