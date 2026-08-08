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
- A persistent draggable fellowship table on host and joined-player screens.
  Players choose from eight knight variants; each player keeps a stable color
  across their avatar, name, and chat messages.
- Completed mission shields are clickable on host and phones. Their tooltip
  shows the leader, quest party, Success count, and Fail count.
- Refresh and temporary-disconnect recovery restores the same seat, role, and
  current actionable phase, timers, and recent chat using a private browser
  token that survives tab closure. The host can issue a five-minute recovery
  code when a player must move to another phone.
- Lobby ready indicators, phone action vibration,
  screen wake lock where supported, and action-needed page titles.
- A same-origin QR code plus copy/share controls for joining a room.
- A post-game Chronicle summarizes leaders, parties, public vote totals, and
  aggregate quest results without revealing who submitted individual cards.
- Multiple independent rooms can run concurrently.
- Optional beta-test mode fills a lobby with legal bot players.
- Persistent, timestamped chat and replay-oriented game event logs in one
  bounded SQLite database.
- Responsive layouts for iPhones, other phones, laptops, and cast/TV screens.
- No analytics, advertising, tracking, or public history endpoints.

The host may also play: keep `/host` on the shared display and join normally
from that person's phone. The host display does not consume a player seat.

## Playing

1. Open `https://YOUR-PUBLIC-HOST/host` on the shared display and create a game.
2. Players open `https://YOUR-PUBLIC-HOST`, enter the four-letter room code and
   a name, then optionally choose a knight.
3. Players choose a knight and may mark themselves ready. Start once 6–10
   players have joined. The host can reorder seating and adjust the discussion
   timer or disable the advisory proposal timer.
4. During play, tap a completed mission shield to inspect that mission. Tap
   elsewhere to dismiss the tooltip.

Avatar positions are draggable and resettable. Layout choices are kept in that
browser's local storage; they do not alter game state or reveal roles.

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

Live rooms and reconnect tokens are intentionally memory-only. A container or
server restart ends active games, so deploy between games. Inactive rooms are
reclaimed after 12 hours by default.

The `avalon_chat_data` Docker volume contains `/data/avalon-chats.sqlite3`.
It persists across container recreation and stores:

- Chat: UTC timestamp, room, game start time, player name, and message.
- Game events: roster and roles, settings, leaders, proposals, individual
  votes, mission parties and individual cards, mission results, assassination,
  and final result.

No cookies, reconnect tokens, authorization values, environment variables, or
IP addresses are written to this database. Game logs intentionally contain
player names and hidden game information for later replay and balance analysis.

Chat and events share a hard 900 MiB SQLite limit, leaving headroom below
1 GiB. Near the limit, old records are pruned to approximately 720 MiB.

```bash
# List and read chat
sudo docker compose exec avalon python chat_history.py --dates
sudo docker compose exec avalon python chat_history.py --date 2026-08-07
sudo docker compose exec avalon python chat_history.py --date 2026-08-07 --room ABCD

# List recorded games, then replay one chronological event stream
sudo docker compose exec avalon python game_history.py --games
sudo docker compose exec avalon python game_history.py --room ABCD --started-at 1786123456.123
```

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
| `SECRET_KEY` | Required random secret of at least 32 characters. |
| `PUBLIC_BASE_URL` | Public HTTPS URL used in join instructions. |
| `PUBLIC_ORIGIN` | Exact allowed HTTP/WebSocket origin. |
| `TRUST_PROXY_HEADERS` | `true` when running behind Funnel/proxy. |
| `ENABLE_DEV_ROUTES` | Keep `false` in production. |
| `MAX_CONNECTIONS` | Global live connection limit; default `100`. |
| `MAX_CONNECTIONS_PER_IP` | Per-source limit; default `30`. |
| `MAX_GAMES` | Active in-memory room limit; default `50`. |
| `MAX_RATE_KEYS` | Bound for rate-limit bookkeeping; default `5000`. |
| `GAME_TTL_SECONDS` | Inactive-room lifetime; default `43200` (12 hours). |
| `CHAT_DB_PATH` | SQLite path; Compose uses `/data/avalon-chats.sqlite3`. |
| `CHAT_DB_MAX_BYTES` | Requested DB cap, hard-limited to 900 MiB. |

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
Flask-SocketIO, Gunicorn, vanilla JavaScript/CSS, and SQLite. Source image and
sound assets are retained for possible future use but excluded from the current
container; the current UI is silent and uses CSS/inline SVG artwork.
