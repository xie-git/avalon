# Avalon

A small, real-time, Jackbox-style implementation of *The Resistance: Avalon*.
One shared host screen drives the game while 6–10 players use their phones. No
accounts, app installation, or Tailscale access are required for players.

## Features

- Complete 6–10 player Avalon flow: private roles, night information,
  discussion, team proposals, voting, quests, assassination, and role reveal.
- A TV-friendly host display with room/leader badges, mission tracker, timers,
  phase-specific status panels, optional recent chat, and in-game settings.
- A phone UI with private actionable controls, reconnect messaging, role
  reminder, mission board, and short live chat.
- Cinematic, edge-to-edge role reveals use dedicated character artwork, muted
  overlay copy, and a delayed confirmation action. Loyal Servants randomly
  receive one of two portraits. Quest outcomes use the same immersive treatment
  with separate Success and Fail artwork while normal game controls stay hidden.
- Spectators can join without taking a player seat, watch every public phase,
  chat with a visible spectator badge, and arrange their own private suspicion
  board without affecting the group average.
- A persistent draggable fellowship table on host and joined-player screens.
  Players can take a selfie or choose from ten illustrated avatars; each player
  keeps a stable portrait and color across the table, night knowledge, proposed
  quest parties, vote reveals, and chat messages.
- Public votes reveal one player portrait at a time with an animated Approve or
  Reject stamp. Private night knowledge likewise identifies known players with
  their table portraits instead of plain text.
- The suspicion spectrum includes a compact, team-colored key showing exactly
  which Good and Evil characters are present for the current 6–10 player game.
- Completed mission shields are clickable on host and phones. Their tooltip
  shows the leader, quest party, Success count, and Fail count.
- Refresh and temporary-disconnect recovery restores the same seat, role, and
  current actionable phase, timers, and recent chat using a private browser
  token that survives tab closure. The host can issue a five-minute recovery
  code when a player must move to another phone.
- Every lobby and game is durably saved. When the last real player disconnects,
  timers freeze and the room remains resumable for 24 hours; resuming starts a
  fresh 24-hour inactivity window the next time everyone leaves.
- A focused phone mode chooser handles joining, hosting, spectating, resuming,
  and seat recovery. Optional displays pair at `/host` with a one-use code.
- A paired display that reconnects to a suspended room offers **Pair a different
  game**. This clears only that browser's display credentials, so the saved room
  remains recoverable from a seated player's phone. The phone host can fully end
  the room from Settings.
- Lobby ready indicators, phone action vibration,
  screen wake lock where supported, and action-needed page titles.
- A same-origin QR code plus copy/share controls for joining a room.
- A post-game Chronicle summarizes leaders, parties, public vote totals, and
  aggregate quest results without revealing who submitted individual cards.
- The final reveal includes a screenshot-friendly portrait of the winning
  fellowship and a voluntary **Run It Back** ready-up for the seated players.
- During discussion, the current leader may place any player in the optional
  Accusation Spotlight as a theatrical invitation to defend their case.
- Multiple independent rooms can run concurrently.
- Persistent, timestamped chat and replay-oriented game event logs in one
  bounded SQLite database.
- Responsive layouts for iPhones, other phones, laptops, and cast/TV screens.
- No advertising, third-party analytics, or public history endpoints. Local,
  first-party operational and research events stay in the private SQLite volume.

The host may also play: keep `/host` on the shared display and join normally
from that person's phone. The host display does not consume a player seat.

## Playing

1. Open `https://YOUR-PUBLIC-HOST`, choose **Host a Game**, and enter your
   name. Use `/new` to explicitly bypass a saved room.
2. Other players enter the four-letter room code and a name, then take a selfie
   or choose an illustrated avatar. The phone host can generate a six-digit code
   if the group wants to pair a TV or laptop at `/host` as the shared display.
3. Players may mark themselves ready. Start once 6–10
   players have joined. The host can reorder seating and adjust the discussion
   timer from 1–15 minutes (or Unlimited) and disable the advisory proposal
   timer.
4. During play, tap a completed mission shield to inspect that mission. Tap
   elsewhere to dismiss the tooltip. Tap **My Role** in the phone header to
   reopen the illustrated private role card.

The phone host's Settings panel shows both the room code and a refreshable
display-pairing code during a started game. If a TV browser is stuck on an old
suspended room, choose **Pair a different game** on that display and enter the
new room and pairing codes. This does not delete the old room; use **End Game**
from the authenticated host phone when the room itself should be discarded.

Avatar positions are draggable and resettable. Layout choices are kept in that
browser's local storage; they do not alter game state or reveal roles.

## Project layout and artwork

Runtime artwork is organized by purpose under `static/`:

| Path | Contents |
| --- | --- |
| `static/assets/roles/` | Character reveal and role-reminder artwork. |
| `static/assets/quests/` | Fullscreen successful/failed quest artwork. |
| `static/assets/results/` | Good/Evil final-result backgrounds. |
| `static/img/` | Entry background, title treatment, and UI imagery. |
| `static/sounds/` | Retained music and sound-effect sources (excluded from the production image). |

`source-assets/` holds distinct original or concept images that are not served
by Flask and are excluded from the Docker build context. Do not point runtime
CSS or JavaScript at that directory; copy an approved, web-ready asset into the
appropriate `static/` subdirectory first. `ops/` contains machine/setup helpers
that are useful to the project but are not part of the application image.

## Ruleset

| Players | Good / Evil | Quest team sizes |
| --- | --- | --- |
| 6 | 4 / 2 | 2, 3, 4, 3, 4 |
| 7 | 4 / 3 | 2, 3, 3, 4, 4 |
| 8 | 5 / 3 | 3, 4, 4, 5, 5 |
| 9 | 6 / 3 | 3, 4, 4, 5, 5 |
| 10 | 6 / 4 | 3, 4, 4, 5, 5 |

Merlin, Percival, Assassin, and Morgana are always used. Games with 7–9
players add a Minion of Mordred; 10-player games use Mordred and Oberon. All
players vote, ties reject, and five consecutive rejected teams give Evil the
game. Quest four requires two Fails with 7–10 players. Good players can only
play Success. After three successful quests, the Assassin must identify Merlin.

Lady of the Lake, Plot, Excalibur, Lancelot, and other optional variants are
not implemented.

## State, chat, and game history

Live rooms and hashed reconnect capabilities are stored in the same SQLite
volume as chat and history. A container restart restores saved rooms in a
suspended state. Raw reconnect, host, recovery, and display-pairing secrets are
never written to disk. Rooms expire 24 hours after the last real player
disconnects unless a player resumes first.

The `avalon_chat_data` Docker volume contains `/data/avalon-chats.sqlite3`.
It persists across container recreation and stores:

- Chat: UTC timestamp, room, game start time, player name, and message.
- Game events: roster and roles, settings, leaders, proposals, individual
  votes, mission parties and individual cards, mission results, assassination,
  and final result.
- Active-room snapshots: the latest authoritative room state and hashed
  capabilities needed for restart-safe resumption.
- Selfie metadata: timestamp, room, player ID/name, content hash,
  private filename, and compressed byte count.
- Product analytics: versioned room/lobby/phase/action/rematch/connectivity events
  with resettable browser IDs and bounded metadata. IP addresses, tokens, and
  free-form client text are not stored.

Selfies are resized to 128 x 128 and JPEG-compressed in the player's browser.
The server stores the bytes by SHA-256 content hash under
`/data/private/selfies`, outside Flask's public `static` tree, with directory
mode `0700` and file mode `0600`. Repeated identical images share one file but
each upload receives its own SQLite metadata row. No HTTP route serves
the archive.

No cookies, reconnect tokens, authorization values, environment variables, or
IP addresses are written to this database. Game logs intentionally contain
player names and hidden game information for later replay and balance analysis.

Chat, events, room snapshots, selfie metadata, and product analytics share a
hard 2.5 GiB SQLite limit. Near the limit, old chat, game-event, and product
analytics records are pruned to approximately 2 GiB. The external selfie files
are intentionally not auto-deleted; include the whole Docker volume in backups
and monitor its disk usage.

```bash
# List and read chat
sudo docker compose exec avalon python chat_history.py --dates
sudo docker compose exec avalon python chat_history.py --date 2026-08-07
sudo docker compose exec avalon python chat_history.py --date 2026-08-07 --room ABCD

# List recorded games, then replay one chronological event stream
sudo docker compose exec avalon python game_history.py --games
sudo docker compose exec avalon python game_history.py --room ABCD --started-at 1786123456.123

# List private selfie metadata and server-side file paths (no public endpoint)
sudo docker compose exec avalon python selfie_history.py --limit 100

# Export a private browsable copy (open index.html locally, then delete when done)
sudo docker compose exec avalon python selfie_history.py --limit 1000 --export /data/private/gallery
sudo docker compose cp avalon:/data/private/gallery ./avalon-selfie-gallery

# Inspect product analytics
sudo docker compose exec avalon python analytics_history.py --summary
sudo docker compose exec avalon python analytics_history.py --party-id PARTY_ID
```

Live victory cards still include player selfies. Durable game-event summaries
store the selfie SHA-256 reference rather than a second base64 JPEG; the private
archive remains the authoritative historical copy. Existing historical event
rows are not rewritten.

## Production deployment

The included Compose configuration is designed for a dedicated small VM behind
Tailscale Funnel:

- Gunicorn with one process, required because live game state is in memory.
- Container runs as an unprivileged user with a read-only root filesystem.
- All Linux capabilities are dropped and `no-new-privileges` is enabled.
- CPU, memory, PID, temporary-storage, and rotating-log limits are set.
- Port 5001 binds only to VM loopback; Funnel terminates public HTTPS.
- The container restarts unless explicitly stopped and has an HTTP healthcheck.

Install Docker Engine/Compose and Tailscale using their official instructions,
clone this repository, then create the production environment:

```bash
cd ~/avalon
cp -n .env.example .env
python3 -c 'import secrets; print(secrets.token_hex(32))'
nano .env
chmod 600 .env
```

Set `SECRET_KEY` to the generated value. Set `PUBLIC_BASE_URL` and
`PUBLIC_ORIGIN` to the exact public HTTPS origin, without a trailing slash.
The application refuses unsafe/incomplete production configuration.

```bash
sudo docker compose config --quiet
sudo docker compose build --pull
sudo docker compose up -d
sudo docker compose ps
curl --fail http://127.0.0.1:5001/healthz
```

Publish only the loopback service:

```bash
sudo tailscale funnel --bg 5001
tailscale funnel status
```

Do not bind the Compose port to `0.0.0.0`, expose the Docker socket, mount host
credentials, or add a router port-forward. The VM and Tailscale Funnel are the
intended network boundary.

### Configuration

| Variable | Production purpose / default |
| --- | --- |
| `APP_ENV` | Set to `production` to enforce production checks. |
| `APP_VERSION` | Release/commit label written with every product event. |
| `SECRET_KEY` | Required random secret of at least 32 characters. |
| `PUBLIC_BASE_URL` | Public HTTPS URL used in join instructions. |
| `PUBLIC_ORIGIN` | Exact allowed HTTP/WebSocket origin. |
| `TRUST_PROXY_HEADERS` | `true` when running behind Funnel/proxy. |
| `ENABLE_DEV_ROUTES` | Keep `false` in production. |
| `MAX_CONNECTIONS` | Global live connection limit; default `100`. |
| `MAX_CONNECTIONS_PER_IP` | Per-source limit; default `30`. |
| `MAX_GAMES` | Active in-memory room limit; default `50`. |
| `MAX_RATE_KEYS` | Bound for rate-limit bookkeeping; default `5000`. |
| `GAME_TTL_SECONDS` | Suspended-room lifetime; default `86400` (24 hours). |
| `CHAT_DB_PATH` | SQLite path; Compose uses `/data/avalon-chats.sqlite3`. |
| `SELFIE_ARCHIVE_DIR` | Private, non-static directory for compressed selfies. |
| `CHAT_DB_MAX_BYTES` | Requested DB cap, hard-limited to 2.5 GiB. |

Keep `.env` private and uncommitted. The checked-in `.env.example` contains no
working credential.

### Updating and operations

Update between games:

```bash
cd ~/avalon
git pull --ff-only
sudo docker compose up -d --build
curl --fail http://127.0.0.1:5001/healthz
```

Useful checks:

```bash
sudo docker compose ps
sudo docker compose logs --tail=100 avalon
tailscale funnel status
```

Routine request logging is disabled. Docker retains at most three 10 MiB local
log files; application errors still appear in the container log. Keep Ubuntu,
Docker, Tailscale, and Python dependencies patched.

## Security model

This is hardened for a small public hobby game, not sustained hostile traffic:

- A random host capability protects host-only actions; the room code alone
  grants only player access.
- Private reconnect tokens and roles are sent only to the relevant browser.
- Replacement-phone seat recovery requires a short-lived code issued by the
  authenticated host and rotates the previous reconnect token.
- Reconnecting from a replacement tab revokes the old socket.
- HTTP and WebSocket payload sizes, names, lists, room/player counts, games,
  connections, and event rates are bounded and validated server-side.
- Production WebSockets accept only the configured origin.
- Security headers deny framing and unnecessary browser capabilities.
- Debug/development routes cannot be enabled in production.
- Stale rooms, sockets, timers, and rate-limit state are cleaned up.

Four-letter room codes are intentionally discoverable and are not passwords.

## Local development and tests

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python server.py
```

Open `http://127.0.0.1:5001/host` and `http://127.0.0.1:5001`. To enable the
local debug route, set `ENABLE_DEV_ROUTES=true`; it remains unavailable in
production.

```bash
.venv/bin/pytest -q
```

The application is deliberately database-light and framework-light: Flask,
Flask-SocketIO, Gunicorn, vanilla JavaScript/CSS, and SQLite. Runtime images
under `static/` are copied into the container. Retained audio sources,
archival originals under `source-assets/`, and operational helpers under
`ops/` are not.
