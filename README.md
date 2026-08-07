# Avalon

A Jackbox-style, real-time Avalon game for one host display and 6–10 player
phones. The host opens `/host`, clicks **Create Game**, and receives a
four-letter room code. Everyone else opens the main URL and joins with that
same code—no account, app, VPN, or Tailscale installation is required for
players.

The server can run multiple independent games at once. It keeps game state in
memory, so restarting the container ends active games. Inactive games are
automatically reclaimed after 12 hours.

Image and sound source files remain in the repository for future use, but the
current party build does not reference or ship them. The UI uses text, CSS, and
inline game symbols only, keeping the phone download small and silent.

## What remains protected

The simple interface does not expose the underlying controls:

- The host browser receives a private random capability after creating a game.
- Knowing or guessing the four-letter room code lets someone join as a player,
  but does not grant host controls.
- Player reconnect tokens and roles are private to each browser.
- Production accepts WebSockets only from the configured public origin.
- The application validates and rate-limits requests.
- Development and debug routes are unavailable in production.
- Docker exposes Avalon only on VM loopback for Tailscale Funnel to proxy.

This is appropriate for a small party game. It is not intended to resist a
large, sustained denial-of-service attack.

## Host and player flow

1. Open `https://YOUR-VM-NAME.YOUR-TAILNET.ts.net/host` on the shared display.
2. Click **Create Game**.
3. Players open `https://YOUR-VM-NAME.YOUR-TAILNET.ts.net` on their phones.
4. They enter the displayed four-letter code and a name.
5. The host starts after 6–10 players have joined.

Each host receives a different code, so several games can run concurrently.

## Ruleset and player counts

Avalon supports every party size from 6 through 10. The alignment counts and
quest teams follow the published rulebook:

| Players | Good / Evil | Quest team sizes |
| --- | --- | --- |
| 6 | 4 / 2 | 2, 3, 4, 3, 4 |
| 7 | 4 / 3 | 2, 3, 3, 4, 4 |
| 8 | 5 / 3 | 3, 4, 4, 5, 5 |
| 9 | 6 / 3 | 3, 4, 4, 5, 5 |
| 10 | 6 / 4 | 3, 4, 4, 5, 5 |

Merlin, Percival, Assassin, and Morgana are used at every size. Games with
7–9 players add a regular Minion of Mordred; 10-player games use Mordred and
Oberon instead. All players, including the Leader, vote. Ties reject a team;
five consecutive rejections give Evil the game. Only the fourth quest in a
7–10 player game requires two Fail cards. Good players must submit Success,
and after three successful quests the Assassin must name a Good player as
Merlin. Optional targeting, Lady of the Lake, Plot, Excalibur, and Lancelot
variants are intentionally not enabled. See the
[published Avalon rulebook](https://www.rulespal.com/resistance-avalon/rulebook).

## New Ubuntu VM setup

These instructions assume Ubuntu 24.04 or 26.04 and that this repository is
already cloned. Commands using `sudo` will ask for the VM user's password.

### 1. Update the VM

```bash
sudo apt update
sudo apt upgrade -y
sudo apt install -y ca-certificates curl git
```

Reboot if Ubuntu reports that a reboot is required:

```bash
sudo reboot
```

### 2. Install Docker Engine and Compose

Skip this section if both `sudo docker version` and
`sudo docker compose version` already work.

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker run --rm hello-world
```

These are the commands from Docker's official Ubuntu installation method. The
Compose file continues using `sudo`, so membership in the root-equivalent
`docker` group is not required. See the
[official Docker instructions](https://docs.docker.com/engine/install/ubuntu/)
if Ubuntu or Docker changes these steps.

### 3. Pull Avalon

From the existing clone:

```bash
cd ~/avalon
git pull --ff-only
git rev-parse --short HEAD
```

The expected commit is the latest commit on `main`.

### 4. Install and connect Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale status
```

Open the authentication URL printed by `tailscale up`. Then obtain the VM's
full MagicDNS name:

```bash
tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))'
```

It will look similar to `avalon-vm.example-tailnet.ts.net`.
See the [official Tailscale Linux instructions](https://tailscale.com/docs/install/linux)
if the installer reports an unsupported distribution.

### 5. Create the production configuration

```bash
cd ~/avalon
cp -n .env.example .env
python3 -c 'import secrets; print(secrets.token_hex(32))'
nano .env
```

Replace `SECRET_KEY` with the generated value. Replace both example URLs with
the exact HTTPS URL formed from the Tailscale DNS name, without a trailing
slash. For example:

```dotenv
APP_ENV=production
SECRET_KEY=PASTE_THE_GENERATED_VALUE_HERE
PUBLIC_BASE_URL=https://avalon-vm.example-tailnet.ts.net
PUBLIC_ORIGIN=https://avalon-vm.example-tailnet.ts.net
TRUST_PROXY_HEADERS=true
ENABLE_DEV_ROUTES=false
MAX_CONNECTIONS=100
MAX_GAMES=50
MAX_RATE_KEYS=5000
GAME_TTL_SECONDS=43200
```

Protect the file and validate the Compose configuration:

```bash
chmod 600 .env
sudo docker compose config --quiet
```

The application intentionally refuses to start with the example secret.
Never commit `.env`.

### 6. Build and start Avalon locally

```bash
sudo docker compose build --pull
sudo docker compose up -d
sudo docker compose ps
curl --fail http://127.0.0.1:5001/healthz
```

The expected response is `{"status":"ok"}` and Compose should report the
container as healthy. Port 5001 is bound only to `127.0.0.1`; do not add a
router port-forward or change it to `0.0.0.0`.

View logs without exposing `.env`:

```bash
sudo docker compose logs --tail=100 avalon
```

### 7. Publish through Tailscale Funnel

Only do this after the local health check succeeds:

```bash
sudo tailscale funnel --bg 5001
tailscale funnel status
```

The first run may print an approval URL. Funnel terminates public HTTPS and
proxies only to Avalon's loopback port. Anyone can use the resulting `ts.net`
URL; players do not need Tailscale.
The current command options are documented in the
[official Funnel CLI reference](https://tailscale.com/docs/reference/tailscale-cli/funnel).

Test both pages from a phone with Wi-Fi turned off:

```text
https://YOUR-VM-NAME.YOUR-TAILNET.ts.net
https://YOUR-VM-NAME.YOUR-TAILNET.ts.net/host
```

Stop public access without stopping the local container:

```bash
sudo tailscale funnel reset
```

## Updating

Update between games because restarting clears all active rooms:

```bash
cd ~/avalon
git pull --ff-only
sudo docker compose build --pull
sudo docker compose up -d
curl --fail http://127.0.0.1:5001/healthz
```

Useful status commands:

```bash
sudo docker compose ps
sudo docker compose logs --tail=100 avalon
tailscale funnel status
```

## Local development

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python server.py
```

Open `http://127.0.0.1:5001/host`. Run the test suite with:

```bash
.venv/bin/pytest -q
```

Development-only routes require `ENABLE_DEV_ROUTES=true` and remain forbidden
when `APP_ENV=production`.

## Capacity and operational notes

- One Gunicorn process is required while state remains in memory; do not add
  application workers.
- The default discussion timer is 60 seconds and can be adjusted from 10
  seconds to 10 minutes on the host lobby screen.
- The process has 100 threads for hosts and players across concurrent rooms.
- Defaults allow 100 live connections and 50 active room records. A full game
  uses up to 11 connections (one host plus ten players).
- `GAME_TTL_SECONDS=43200` reclaims inactive rooms after 12 hours when another
  room is created.
- A container restart ends all games and invalidates all reconnect tokens.
- Keep Ubuntu, Docker, Tailscale, and Python dependencies patched.
