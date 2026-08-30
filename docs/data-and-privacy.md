# Data, privacy, backups, and history

Avalon keeps first-party operational and research data so rooms can recover
after disconnects/restarts and completed games can be analyzed. There are no
public history endpoints, advertising trackers, or third-party analytics.

This archive is private, but it is not anonymous: it can contain player names,
voluntary selfie references, chat text, roles, votes, quest cards, and
pseudonymous cross-game identifiers. Hosts should disclose that
collection to players and protect exports and backups accordingly.

## Storage layout

The Compose volume `avalon_chat_data` is mounted at `/data` and contains:

| Path | Contents |
| --- | --- |
| `/data/avalon-chats.sqlite3` | Chat, game events, active-room snapshots, selfie metadata, product events, and canonical research tables. |
| `/data/private/selfies/` | Content-addressed 128 × 128 JPEG selfies; outside Flask's public static tree. |
| `/data/private/backups/` | Operator-created backups; the application does not create scheduled backups automatically. |
| `/data/private/` | Recommended location for explicit history/research exports. |

The database stores:

- chat timestamp, room/game context, player name, and message text;
- replay-oriented game events, including roster/roles, proposals, individual
  votes, quest parties/cards, assassination, and outcome;
- the latest active-room state plus hashed recovery capabilities required for
  restart-safe resumption;
- selfie timestamp, room/player identity, SHA-256, private filename, and byte
  count, but not a duplicate image blob;
- bounded product events without IP addresses, authorization values, or
  arbitrary client error/message text;
- canonical research streams, replay checkpoints, normalized games and
  participants, pseudonymous subjects, and browser-session context.

Raw reconnect, host, recovery, and display-pairing secrets are never persisted.
Hashed recovery capabilities exist only in the operational `active_rooms`
snapshot; they are excluded from game, product, and research records. No HTTP
route serves the selfie archive or private history.

## Room and selfie lifecycle

When the final real player disconnects, timers freeze and the room is saved as
suspended. It remains resumable for 24 hours by default. A successful resume
reactivates the room; the next full disconnect starts a fresh inactivity
window. Restarted containers load saved rooms in suspended state.

Browsers resize selfies to 128 × 128 and JPEG-compress them before upload. The
server stores them by SHA-256 with directory mode `0700` and file mode `0600`.
Identical images share a file, though every accepted upload receives its own
metadata row. Selfie files are intentionally not removed by automatic database
pruning.

## Size and retention

SQLite is hard-limited to 2.5 GiB. Near the configured limit, old legacy chat,
game-event, and product-event rows are pruned first. Research data is removed
only as the complete oldest terminal game/stream, never as a partial replay;
active games are not research-prune candidates. Selfie metadata is not part of
automatic pruning.

The external selfie files and operator exports/backups do not count toward the
SQLite cap and are not automatically expired. Monitor the entire Docker volume,
define an appropriate retention period, and delete private exports after use.
There is currently no automated subject/game erasure command; a deletion
request requires deliberate database and selfie-archive administration plus a
fresh backup.

## Private history commands

Run these from the repository on the VM. Add `sudo` when the operator account
does not have Docker access.

```bash
# Chat dates and messages (UTC)
docker compose exec avalon python chat_history.py --dates
docker compose exec avalon python chat_history.py --date 2026-08-07
docker compose exec avalon python chat_history.py --date 2026-08-07 --room ABCD

# Legacy chronological game-event history
docker compose exec avalon python game_history.py --games
docker compose exec avalon python game_history.py --room ABCD --started-at 1786123456.123

# Selfie metadata and explicit private gallery export
docker compose exec avalon python selfie_history.py --limit 100
docker compose exec avalon python selfie_history.py --room ABCD --limit 100
docker compose exec avalon python selfie_history.py --limit 1000 --export /data/private/gallery
docker compose cp avalon:/data/private/gallery ./avalon-selfie-gallery

# Legacy product analytics
docker compose exec avalon python analytics_history.py --summary
docker compose exec avalon python analytics_history.py --party-id PARTY_ID

# Canonical research/replay tools
docker compose exec avalon python research_history.py list --status completed
docker compose exec avalon python research_history.py validate GAME_ID
docker compose exec avalon python research_history.py export GAME_ID -o /data/private/game.json
docker compose exec avalon python research_history.py wrapped --subject-id subject_... --year 2026
docker compose exec avalon python research_history.py dataset --redact -o /data/private/avalon.jsonl
```

`research_history.py` refuses to overwrite an export unless `--force` is
explicit. Chat is excluded from canonical exports unless `--include-chat` is
supplied. `--redact` replaces names, subjects, room codes, selfie references,
and message content; review any export before sharing it.

An exported selfie gallery is a private copy, not an application endpoint.
Open it locally, restrict access, and delete it when finished.

## Backups

Back up the complete named volume, not only SQLite, so database selfie
references and the private image archive remain consistent. SQLite backups
must use the SQLite backup API while the application is running; copying the
live database file directly can produce an inconsistent backup.

The database-only hot-backup procedure in
[deployment.md](deployment.md#safe-update-procedure) is the tested schema-update
rollback point. It does not copy selfie files. For disaster recovery, back up
the complete named volume separately. Encrypt off-VM copies, limit access, test
restoration periodically, and retain at least the latest known-good
pre-deployment backup.

For the canonical envelope, replay semantics, integrity validation, normalized
views, and governance details, see [research-data.md](research-data.md).
