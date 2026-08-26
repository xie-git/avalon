# Production deployment and operations

The supported production shape is one small Linux VM running Docker Compose
behind Tailscale Funnel. Compose binds the application only to
`127.0.0.1:5001`; Funnel supplies public HTTPS and proxies WebSocket traffic.

## Runtime constraints

- Run exactly one Gunicorn worker. Live room state is process-local; increasing
  threads is supported, but multiple workers would create divergent rooms.
- The container runs as UID/GID `10001`, with a read-only root filesystem, no
  Linux capabilities, `no-new-privileges`, and bounded CPU, memory, PIDs,
  temporary storage, and logs.
- The named `avalon_chat_data` volume is the only durable runtime storage.
- Do not expose port 5001 on `0.0.0.0`, publish the Docker socket, mount host
  credentials, or add a router port-forward.
- Perform deployments between games. A restart restores saved rooms in a
  suspended state, but connected browsers are briefly disconnected.

## First deployment

Install supported Docker Engine/Compose and Tailscale using their official
instructions, clone the repository, and create the private environment file:

```bash
cd ~/avalon
cp -n .env.example .env
python3 -c 'import secrets; print(secrets.token_hex(32)); print(secrets.token_hex(32))'
nano .env
chmod 600 .env
```

Use the two generated values for `SECRET_KEY` and
`ANALYTICS_PSEUDONYM_KEY`. Set `APP_VERSION` to the commit or build identifier
being deployed. Set `PUBLIC_BASE_URL` to the public HTTPS URL with no trailing
slash and set `PUBLIC_ORIGIN` to that URL's exact origin. Production startup
rejects missing, example, short, non-HTTPS, or mismatched values.

Validate, build, and start:

```bash
sudo docker compose config --quiet
sudo docker compose build --pull
sudo docker compose up -d
sudo docker compose ps
curl --fail http://127.0.0.1:5001/healthz
```

Publish the loopback service and confirm the route:

```bash
sudo tailscale funnel --bg 5001
tailscale funnel status
curl --fail https://YOUR-PUBLIC-HOST/healthz
```

The expected health body is `{"status":"ok"}`.

## Configuration reference

| Variable | Requirement and behavior |
| --- | --- |
| `APP_ENV` | Set to `production` to enable fail-closed production validation. |
| `APP_VERSION` | Commit/release label, limited to 64 characters and stored with product/research events. |
| `SECRET_KEY` | Required in production; at least 32 characters and not the example value. Protects Flask and is the fallback pseudonym key. |
| `ANALYTICS_PSEUDONYM_KEY` | Optional separate stable HMAC key; if set in production, it must meet the same length/example checks. Changing it breaks cross-game subject continuity. |
| `PUBLIC_BASE_URL` | Required absolute HTTPS base URL, without a trailing slash; used for public join links and QR codes. |
| `PUBLIC_ORIGIN` | Required exact origin of `PUBLIC_BASE_URL`; used as the production Socket.IO origin allowlist. |
| `TRUST_PROXY_HEADERS` | Set `true` behind Funnel so Flask honors one proxy hop. |
| `ENABLE_DEV_ROUTES` | Keep `false`; development routes are unavailable in production regardless. |
| `MAX_CONNECTIONS` | Global Socket.IO connection limit; default `100`. |
| `MAX_CONNECTIONS_PER_IP` | Per-source connection limit; default `30`. |
| `MAX_GAMES` | Maximum in-memory rooms; default `50`. |
| `MAX_RATE_KEYS` | Rate-limit bookkeeping bound; default `5000`, minimum `100`. |
| `GAME_TTL_SECONDS` | Suspended-room lifetime; default `86400` (24 hours), minimum one hour outside tests. |
| `RESEARCH_TELEMETRY_ENABLED` | Canonical research events and normalized facts; default `true`. |
| `RESEARCH_CHECKPOINTS_ENABLED` | Intermediate replay checkpoints when telemetry is enabled; default `true`. |
| `CHAT_DB_PATH` | SQLite path; Compose fixes the default to `/data/avalon-chats.sqlite3`. |
| `CHAT_DB_MAX_BYTES` | Requested database limit; Compose defaults to `2684354560` bytes and code enforces a 2.5 GiB maximum. |
| `SELFIE_ARCHIVE_DIR` | Private archive path outside Flask's static tree; Compose defaults to `/data/private/selfies`. |

`PORT` affects the direct development server only. The production Gunicorn and
Compose configuration intentionally use container port 5001.

Keep `.env` mode `0600`, private, and uncommitted. The tracked `.env.example`
contains placeholders only.

## Safe update procedure

Update between games and take a database-only hot SQLite backup before
replacing the container:

```bash
cd ~/avalon
git pull --ff-only
git rev-parse --short HEAD
nano .env  # set APP_VERSION to the commit shown above

sudo docker compose exec -T avalon python - <<'PY'
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

source = sqlite3.connect(os.environ["CHAT_DB_PATH"])
stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
target_path = Path(f"/data/private/backups/avalon-{stamp}.sqlite3")
target_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
if target_path.exists():
    raise FileExistsError(target_path)
target = sqlite3.connect(target_path)
source.backup(target)
target.close()
source.close()
target_path.chmod(0o600)
print(target_path)
PY

sudo docker compose config --quiet
sudo docker compose up -d --build
curl --fail http://127.0.0.1:5001/healthz
curl --fail https://YOUR-PUBLIC-HOST/healthz
sudo docker compose logs --tail=100 avalon
```

Compose applies additive SQLite migrations during startup. Do not interrupt the
first startup, and retain the pre-update backup until the new build has been
used successfully. This in-volume backup is a short-term database rollback
point, not an off-VM disaster-recovery backup and not a copy of selfie files.

## Routine checks

```bash
sudo docker compose ps
sudo docker compose logs --tail=100 avalon
tailscale funnel status
df -h /
docker system df
```

Expected state: one healthy `avalon` container, port 5001 bound to loopback,
Funnel proxying the intended public hostname, and no recurring exceptions in
the container log. Docker retains at most three 10 MiB local log files.

Keep the VM OS, Docker, Tailscale, and pinned Python dependencies patched.
Monitor the named volume and external selfie archive as described in
[data-and-privacy.md](data-and-privacy.md).

## Rollback

If the new container fails before writing important new-version data:

1. Stop the application with `sudo docker compose down` (do not add `-v`).
2. Restore the selected backup while the application is stopped:

   ```bash
   sudo docker compose run --rm --no-deps \
     -e BACKUP_PATH=/data/private/backups/avalon-YYYYMMDDTHHMMSSZ.sqlite3 \
     avalon python - <<'PY'
   import os
   import sqlite3

   source = sqlite3.connect(f"file:{os.environ['BACKUP_PATH']}?mode=ro", uri=True)
   target = sqlite3.connect("/data/avalon-chats.sqlite3")
   source.backup(target)
   target.close()
   source.close()
   PY
   ```

3. Check out the previous known-good commit, set `APP_VERSION` accordingly,
   and run `sudo docker compose up -d --build`.
4. Re-run both local and public health checks.

Never run `docker compose down -v` during ordinary operations; it deletes the
named data volume. A database rollback does not automatically roll back the
separate selfie files, so restore the volume as one backup unit when exact
historical consistency matters.
