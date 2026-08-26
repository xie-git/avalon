# Avalon

A real-time, phone-first implementation of *The Resistance: Avalon* for 6–10
players. One player creates and controls the room from a phone; an optional TV
or laptop can pair as a read-only shared display. Players need only a modern web
browser—there are no accounts or app installations.

## What is implemented

- The complete implemented game loop: private roles, night information,
  discussion, team proposals, public voting, quests, assassination, final role
  reveal, and voluntary rematches.
- Responsive phone and shared-display interfaces with reconnect recovery,
  resumable rooms, timers, role reminders, chat, mission history, and a
  draggable fellowship table.
- Six to ten seated players, optional practice bots, concurrent independent
  rooms, and spectators who can watch and chat without taking a seat.
- Built-in avatars or voluntary 128 × 128 selfies, cinematic role/quest/result
  artwork, a suspicion spectrum, public vote reveals, and a post-game
  Chronicle.
- Durable SQLite storage for active-room recovery, chat, game history,
  first-party product events, private selfie metadata, and canonical research
  streams.
- A hardened single-VM deployment using Gunicorn, Docker Compose, and Tailscale
  Funnel.

No advertising or third-party analytics are included. The server does retain
player names, game decisions, and other first-party data for recovery and
private analysis; see [Data, privacy, and history](docs/data-and-privacy.md)
before hosting the game for others.

## Playing

1. Open the public site, choose **Host a Game**, and enter the name people call
   you in real life. Use `/new` when you intentionally want to bypass a room
   saved in that browser.
2. Other players choose **Join a Game** and enter the four-letter room code and
   a name. Each player can pick an illustrated avatar or supply a selfie.
3. Optionally open `/host` on a TV or laptop. The phone host generates a
   six-digit, one-use pairing code that remains valid for five minutes.
4. Begin once 6–10 seats are occupied. Ready marks are advisory; the host may
   reorder seats, set discussion to 1–15 minutes or Unlimited, and disable the
   advisory 60-second proposal timer.
5. Follow the private actions on each phone. A completed mission shield opens
   that mission's leader, party, and aggregate card result. **My Role** reopens
   the private role card.

The host may also play. The host joins from a phone like everyone else while
the paired display remains read-only and does not consume a seat. A stale paired
display can choose **Pair a different game** without deleting its former room.
**End Game** on the authenticated host phone deletes the room immediately;
otherwise an inactive suspended room expires after its configured lifetime.

## Ruleset

The implementation records its rules as `avalon-base-6-10@2`.

| Players | Good / Evil | Quest team sizes |
| --- | --- | --- |
| 6 | 4 / 2 | 2, 3, 4, 3, 4 |
| 7 | 4 / 3 | 2, 3, 3, 4, 4 |
| 8 | 5 / 3 | 3, 4, 4, 5, 5 |
| 9 | 6 / 3 | 3, 4, 4, 5, 5 |
| 10 | 6 / 4 | 3, 4, 4, 5, 5 |

Merlin, Percival, Assassin, and Morgana are always present. Seven- through
nine-player games add Mordred; ten-player games add Mordred and Oberon. Merlin
cannot see Mordred, Percival sees Merlin and Morgana without knowing which is
which, and Oberon is hidden from the other Evil players.

All players vote and ties reject. This implementation uses a documented house
rule for the rejection track: after four rejected parties, the fifth leader's
party is binding and proceeds without a vote. Quest four requires two Fails at
7–10 players; every other quest requires one. Good players can submit only
Success. Three successful quests trigger the Assassin's attempt to identify
Merlin.

Lady of the Lake, Plot, Excalibur, Lancelot, and other optional variants are not
implemented.

## Repository layout

| Path | Purpose |
| --- | --- |
| `server.py`, `game_logic.py` | HTTP/WebSocket application and authoritative rules. |
| `chat_store.py` | SQLite schema, migrations, pruning, and history/research persistence. |
| `templates/`, `static/` | Browser UI and runtime artwork. |
| `tests/` | Logic, protocol, security, persistence, archive, and research tests. |
| `docs/` | Operator, privacy, and research documentation. |
| `source-assets/` | Original/concept artwork excluded from the application image. |
| `ops/` | Optional, VM-specific host helpers excluded from the application image. |

Runtime role, quest, and result art lives under `static/assets/`; entry/UI art
lives under `static/img/`. `static/sounds/` contains retained audio sources but
is intentionally excluded from the production image. See
[source-assets/README.md](source-assets/README.md) for artwork handling rules.

## Local development

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python server.py
```

Open `http://127.0.0.1:5001` for the phone UI and
`http://127.0.0.1:5001/host` for the shared display. The optional `/dev` route
requires `ENABLE_DEV_ROUTES=true` and is always unavailable when
`APP_ENV=production`.

Run the automated suite with:

```bash
.venv/bin/pytest -q
```

The production process must use one Gunicorn worker because authoritative live
room state is process-local. Threads within that worker handle concurrent
connections.

## Documentation

- [Documentation index](docs/README.md)
- [Production deployment and operations](docs/deployment.md)
- [Data, privacy, backups, and history tools](docs/data-and-privacy.md)
- [Canonical research data specification](docs/research-data.md)
