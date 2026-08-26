# Avalon research data specification

Version: `avalon.research.event/1.0.0`
Replay state: `avalon.replay.state/1.0.0`
Ruleset: `avalon-base-6-10@2`

This document describes the private, first-party research archive. It is built
for exact game replay, statistical analysis, AI datasets, product/reliability
research, and visualization projects such as **Avalon Wrapped**.

## Design guarantees

1. The live `GameState` remains authoritative. Telemetry is best-effort and a
   storage failure never rejects or changes a legal game action.
2. Every party or game has its own append-only sequence while retained.
   Sequence numbers are gapless and each event contains the previous event
   hash. Capacity pruning removes whole terminal research streams, not events
   from the middle of a retained stream.
3. Replay checkpoints contain the complete authoritative research state,
   including facts that were secret during play. Identical consecutive states
   are deduplicated.
4. A normalized game row and participant rows make common SQL analysis possible
   without parsing the replay timeline.
5. The canonical event JSON is versioned. Additive application releases do not
   silently change the meaning of an existing field.
6. Authentication and infrastructure secrets never enter the research layer.

## Data topology

| Entity | Cardinality | Purpose |
| --- | ---: | --- |
| `research_streams` | one per browser session, party, or started game | Sequence allocation, event count, and integrity-chain head/tail |
| `research_events` | many per stream | Canonical gameplay, behavior, UX, reliability, and checkpoint timeline |
| `research_games` | one per started game | Analysis-ready settings, outcome, duration, and mission/proposal facts |
| `research_participants` | players/spectators per game | Seat, stable pseudonymous subject, role/team, appearance, and outcome |
| `research_client_sessions` | one per page load | Page-session duration/context and client event ordering |
| `research_*_facts` SQL views | one row per proposal/team member/vote/quest card/quest/assassination/rating/phase/player-game | Notebook- and BI-friendly projections without copying event data |
| `chat_messages` | many per game | Content plus message/game/actor/phase dimensions; separate from telemetry |
| `active_rooms` | one per live room | Operational recovery snapshot, not an immutable research record |
| `game_events`, `product_events` | legacy compatibility | Existing history/readers; canonical research data is stored in parallel |

The primary hierarchy is:

```text
party_id (same group and room across rematches)
├── party event stream (lobby, joining, setup)
├── game_id A
│   ├── normalized game
│   ├── participants
│   ├── ordered event/checkpoint stream
│   └── optionally linked chat
└── game_id B (rematch)
    └── ...
```

`analytics_id` is a resettable random browser UUID. The canonical archive does
not store it directly. The server HMACs it into a stable `subject_id`, allowing
cross-game Wrapped analysis without exposing the browser identifier. Player IDs
are seat identities scoped to one party/game; client-session IDs are scoped to
one page load.

## Canonical event envelope

Every `event_json` has these sections:

| Path | Meaning |
| --- | --- |
| `spec`, `spec_version` | Format discriminator and semantic version |
| `event_id` | UUID; client event UUIDs also provide idempotency |
| `stream.id/type/sequence` | Browser, party, or game stream and gapless position |
| `time.occurred_at` | Server event time; client time is retained separately |
| `time.recorded_at` | UTC persistence time |
| `time.game_elapsed_ms` | Active game time, excluding a suspended interval |
| `time.phase_elapsed_ms` | Time since the current phase began |
| `application.version` | Deploy/build version |
| `application.ruleset_version` | Rules used to interpret this game |
| `context` | Party, room, game, phase, mission, and proposal attempt |
| `event.source/category/name/visibility` | Stable event classification |
| `actor.type/id/subject_id` | System, display, player, spectator, bot, or browser |
| `client` | Optional page-session UUID, client sequence/time/uptime, page, and coarse context |
| `data` | Event-specific, bounded structured payload |
| `checkpoint.state_hash` | Hash of an attached authoritative replay state |
| `integrity.previous_event_hash` | Hash of the preceding event document |

The separately indexed `event_hash` is SHA-256 over the canonical event JSON.
The hash covers the prior hash and the checkpoint hash, so accidental or
uncoordinated edits, deletions, reordering, and state modification are
detectable with `research_history.py validate`. This is an integrity chain, not
a signature: a privileged database writer who recomputes the entire chain is
outside its threat model.

### Event sources and categories

Sources describe where the fact originated:

| Source | Examples |
| --- | --- |
| `gameplay` | Roster/role manifest, proposal, full vote, full quest cards, assassination, result |
| `product` | Join, ready, timer use, individual decision timing, chat count, rematch |
| `client` | Screen view, help/role-card/chat use, visibility, browser-session context |
| `server_protocol` | Processed Socket.IO action, validation failure, rate limit |
| `state_checkpoint` | Deduplicated authoritative replay state after persistence |

Top-level categories are `lifecycle`, `lobby`, `gameplay`, `social`,
`experience`, `connectivity`, `interaction`, `reliability`, `product`, and
`state`. Analysts should group by category and use the exact event name for a
specific metric.

Visibility is an analysis hint:

- `public`: safe to reveal during the game.
- `private`: participant/product fact not intended for the shared screen.
- `research_secret`: role assignment, individual vote/card, private suspicion,
  or another fact that must stay private until the game is over—and should
  remain in the private archive afterward.

## What is captured

### Room and party lifecycle

- room creation mode, app/ruleset versions, party ID, and room code;
- player and spectator join/reconnect/disconnect, participant type, connection
  reason category, and current counts;
- shared-display pairing request/success/reconnect/disconnect (never the code or
  capability);
- seat-recovery issue/claim (never the recovery code or capability);
- suspend/resume/expiry/host-end/return-to-lobby/rematch status;
- lobby duration can be derived from room creation to game start;
- abandoned and expired started games are finalized distinctly from completed
  games.

### Lobby configuration and identity presentation

- ordered seats, host-player flag, player/bot counts, ready-state changes;
- settings and beta-test mode/target count;
- built-in avatar index or selfie usage, selfie hash/reference, compressed byte
  count, upload/rejection/archive failure;
- name length and latest display name (not the previous name in ordinary product
  payloads);
- spectator vision mode and spectator counts.

### Complete game mechanics

- randomized role/team assignment and seat order;
- exact night acknowledgements and per-player acknowledgement latency;
- round/mission number, leader, required team size, double-fail rule;
- discussion duration, timer expiry/skip, and Accusation Spotlight target/time;
- every intermediate team preview, final party, proposal latency, and leader;
- each player's approve/reject vote and latency, full revealed vote, totals,
  acceptance, and rejection-track state;
- each quest member, each submitted Success/Fail card and latency, shuffled
  public reveal, unshuffled private cards, threshold, result, and scoreboard;
- assassination actor, target, decision latency, Merlin hit/miss, winner, and
  win reason;
- final roles, mission/proposal histories, wall duration, active duration, and
  terminal state.

### Social and behavioral research

- chat message ID, actor, phase/mission/proposal, length, word count, URL flag,
  and content in the separate private chat table;
- every private suspicion-spectrum layout and the public aggregate can be
  reconstructed from checkpoints;
- chat panel opens/closes and unread count, help and role-card usage, selfie
  prompt/capture outcomes, victory/rematch views;
- screen transitions and previous screen, page visibility, page-session uptime,
  connection/reconnection, and action-processing latency;
- coarse screen/viewport class, standalone/browser mode, locale, timezone
  offset, color-scheme and reduced-motion preferences, touch capability,
  online state, and navigation duration.

The client context is intentionally coarse rather than a device fingerprint.
Exact viewport dimensions, user agent, advertising identifiers, third-party
cookies, and canvas/font fingerprints are not collected.

### Reliability and funnel research

- action name, rate-limit bucket, and server processing duration;
- allowlisted client error category (not free-form stack/message);
- validation failure reason category such as wrong phase, wrong actor,
  authorization, duplicate, capacity, not found, or invalid input;
- game-start click, success, and bounded block reason;
- camera permission/capture/archive categories;
- suspension, reconnection, replacement seat, and display recovery.

## Replay checkpoints

`state_checkpoint` rows attach an `avalon.replay.state/1.0.0` document. The
document contains:

- identity and clock/settings/lifecycle;
- ordered players and spectators, roles, teams, bot/host/connection/ready state,
  colors, avatar source, and selfie content hash;
- leader, mission/rejection progress, public proposal and mission histories;
- proposed team IDs, individual votes, pending reveal, individual quest cards,
  night acknowledgements, and pending mission outcome;
- timer kind/deadline/remaining value;
- winner, reason, and assassin target;
- spotlight/rematch state and all private suspicion coordinates.

It never contains raw or hashed reconnect/host/recovery/pairing capabilities,
Socket.IO IDs, IP addresses, environment variables, cookies, or base64 selfie
bytes. Replaying can seek to any checkpoint, render that state, then apply or
display later events in sequence. Since checkpoints occur after authoritative
persistence and identical states are removed, they also form a concise state
change history.

## Normalized analysis fields

`research_games` exposes dimensions and terminal measures directly:

- app/schema/ruleset version;
- party/game/room IDs and UTC/Unix start/end;
- status (`in_progress`, `completed`, `abandoned`, `expired`);
- human/player/spectator counts and settings/role-set JSON;
- winner/reason, active/wall duration;
- proposal, mission, Good/Evil mission counts;
- assassination target and initial/final state hashes.

`research_participants` exposes:

- participant type, game-scoped ID, pseudonymous cross-game subject ID;
- display name, seat, role/team, bot/host flags;
- avatar/color/vision attributes and selfie archive reference;
- first/last observation and whether the player's alignment won.

Granular player measures—vote rate, proposal latency, quest deception, trust
received, spotlight, reconnects, and feature engagement—come from joining
participants to `research_events` on `(game_id, actor_id)`.

The built-in views are `research_proposal_facts`,
`research_team_member_facts`, `research_vote_facts`,
`research_mission_card_facts`, `research_mission_facts`,
`research_assassination_facts`, `research_spectrum_rating_facts`,
`research_phase_facts`, and `research_player_game_stats`. They flatten JSON and
perform common joins while leaving the append-only stream as the source of
truth.

## Avalon Wrapped output

The `wrapped` command returns visualization-ready JSON rather than presentation
HTML. Current sections include:

- games, wins/losses, win rate, and active play time;
- alignment split, role distribution, and favorite role;
- approve/reject style and average vote latency;
- leadership count, proposal latency, and party acceptance rate;
- number of times trusted with a quest, quests played, Success/Fail cards, and
  card latency;
- Assassin attempts/accuracy/latency;
- chat, help, role-card, reconnect, spotlight, and rematch engagement;
- favorite UTC day/start hour, longest game, and most frequent pseudonymous
  co-player;
- a compact `cards` array ready for a story/carousel UI plus per-game details.

Possible later visualizations need no schema change: suspicion accuracy over
time, trust networks from party selection, voting blocs, role-specific survival
curves, leader decision trees, quest deception timing, rejection-pressure
effects, table-position effects, cohort retention, recovery funnels, phase
dwell-time Sankeys, and version/ruleset A/B comparisons.

## Private CLI

Inside the production container:

```bash
# Discover game IDs
python research_history.py list
python research_history.py list --status completed

# Verify the immutable timeline and every checkpoint hash
python research_history.py validate GAME_ID

# Full private replay; chat content is opt-in
python research_history.py export GAME_ID -o /data/private/game.json
python research_history.py export GAME_ID --include-chat -o /data/private/game-with-chat.json

# Shareable/research-review variant (names, subjects, room, selfie refs, and
# chat content are removed/replaced)
python research_history.py export GAME_ID --redact -o /data/private/game-redacted.json

# One manifest line followed by one canonical bundle per game
python research_history.py dataset --status completed --redact \
  -o /data/private/avalon-research.jsonl

# Stable subject IDs appear in participant exports. A raw browser analytics UUID
# can also be transformed when the same pseudonym key is available.
python research_history.py wrapped --subject-id subject_... --year 2026
python research_history.py wrapped --analytics-id UUID --year 2026 \
  -o /data/private/avalon-wrapped-2026.json
```

Commands refuse to overwrite an existing file unless `--force` is explicit.
Exports omit chat by default. `--redact` also replaces chat text even when
`--include-chat` is supplied.

## Privacy and governance

This archive is deliberately private and has no HTTP history endpoint. It can
still contain personal data: display names, voluntary selfie references,
stable pseudonymous subjects, private game decisions, suspicion ratings, and—
when explicitly exported—chat content. Operators should disclose the research
collection to players, restrict host/filesystem access, encrypt backups, avoid
publishing unredacted bundles, and honor deletion requests by subject/game.

Not collected in research events:

- IP address or precise location;
- raw or hashed authentication/reconnect capabilities;
- host/recovery/display codes;
- cookies, contact details, address book, microphone, or ambient audio;
- raw user agent or fingerprinting surfaces;
- arbitrary client error text/stacks;
- selfie JPEG bytes (the separately protected selfie archive remains the source
  of truth).

Set `RESEARCH_TELEMETRY_ENABLED=false` to disable the new canonical stream and
normalized research tables. Set `RESEARCH_CHECKPOINTS_ENABLED=false` to retain
events/facts and normalized initial/final state while omitting intermediate
replay checkpoints. `ANALYTICS_PSEUDONYM_KEY` should be stable and secret; it
falls back to `SECRET_KEY` in production.

The bounded SQLite policy removes old legacy rows first. If research data must
be removed for space, it deletes an entire oldest terminal game stream and its
normalized rows atomically rather than leaving a deceptively partial replay.
Active games are not research-prune candidates. Keep versioned, encrypted
backups for any retention period required by the study and document that period
for participants.

## Versioning rules

- Adding an optional field is backward-compatible and retains the current major
  version.
- Renaming/removing a field or changing meaning/unit increments the major
  version.
- Event timestamps are UTC ISO 8601; durations are integer milliseconds;
  mission numbers and proposal attempts are one-indexed.
- IDs are opaque strings. Consumers must not infer identity from their shape.
- Unknown events/fields must be preserved or ignored, never treated as invalid.
- Ruleset version is separate from event/replay format so optional Avalon rules
  can evolve without corrupting historical interpretation.
