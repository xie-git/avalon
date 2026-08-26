import os
import json
import sqlite3
import threading
import uuid
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

from research_telemetry import (
    MAX_REPLAY_STATE_BYTES,
    MAX_RESEARCH_PAYLOAD_BYTES,
    RESEARCH_SPEC_VERSION,
    build_event_document,
    canonical_json,
    chained_event_hash,
    sha256_json,
    utc_timestamp,
)


DEFAULT_MAX_BYTES = 2_560 * 1024 * 1024
HARD_MAX_BYTES = 2_560 * 1024 * 1024
DEFAULT_DB_PATH = "/tmp/avalon-chats.sqlite3"


class ChatStore:
    """Small, thread-safe SQLite archive for game chat messages."""

    def __init__(self, path: str, max_bytes: int = DEFAULT_MAX_BYTES):
        self.path = Path(path)
        self.max_bytes = min(max(512 * 1024, int(max_bytes)), HARD_MAX_BYTES)
        self.prune_at_bytes = max(256 * 1024, self.max_bytes - 16 * 1024 * 1024)
        self.prune_to_bytes = int(self.max_bytes * 0.8)
        self._lock = threading.Lock()
        self._initialized = False

    def _connect(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 5000")
        connection.execute("PRAGMA synchronous = NORMAL")
        connection.execute("PRAGMA foreign_keys = ON")
        page_size = connection.execute("PRAGMA page_size").fetchone()[0]
        max_pages = max(128, self.max_bytes // page_size)
        connection.execute(f"PRAGMA max_page_count = {max_pages}")
        return connection

    @staticmethod
    def _ensure_columns(
        connection: sqlite3.Connection, table: str, columns: dict[str, str]
    ) -> None:
        """Apply additive migrations to databases created by older releases."""
        existing = {
            row["name"] for row in connection.execute(f"PRAGMA table_info({table})")
        }
        for name, declaration in columns.items():
            if name not in existing:
                connection.execute(
                    f"ALTER TABLE {table} ADD COLUMN {name} {declaration}"
                )

    def _initialize(self, connection: sqlite3.Connection) -> None:
        if self._initialized:
            return
        connection.execute("PRAGMA page_size = 4096")
        connection.execute("PRAGMA auto_vacuum = FULL")
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                room_code TEXT NOT NULL,
                game_started_at REAL,
                player_name TEXT NOT NULL,
                message TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS game_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                room_code TEXT NOT NULL,
                game_started_at REAL NOT NULL,
                event_type TEXT NOT NULL,
                payload_json TEXT NOT NULL
            )
            """
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_game_events_game "
            "ON game_events(room_code, game_started_at, id)"
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS product_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                schema_version INTEGER NOT NULL,
                app_version TEXT NOT NULL,
                party_id TEXT,
                room_code TEXT,
                game_id TEXT,
                game_started_at REAL,
                actor_type TEXT NOT NULL,
                actor_id TEXT,
                analytics_id TEXT,
                event_type TEXT NOT NULL,
                phase TEXT,
                mission_num INTEGER,
                proposal_attempt INTEGER,
                payload_json TEXT NOT NULL
            )
            """
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_product_events_game "
            "ON product_events(game_id, id)"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_product_events_party "
            "ON product_events(party_id, id)"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_product_events_created_at "
            "ON product_events(created_at)"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at "
            "ON chat_messages(created_at)"
        )
        self._ensure_columns(
            connection,
            "chat_messages",
            {
                "message_id": "TEXT",
                "party_id": "TEXT",
                "game_id": "TEXT",
                "actor_type": "TEXT",
                "actor_id": "TEXT",
                "subject_id": "TEXT",
                "phase": "TEXT",
                "mission_num": "INTEGER",
                "proposal_attempt": "INTEGER",
                "message_length": "INTEGER",
                "word_count": "INTEGER",
                "contains_url": "INTEGER",
            },
        )
        connection.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_message_id "
            "ON chat_messages(message_id) WHERE message_id IS NOT NULL"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_chat_messages_game_id "
            "ON chat_messages(game_id, id)"
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS active_rooms (
                room_code TEXT PRIMARY KEY,
                schema_version INTEGER NOT NULL,
                state_json TEXT NOT NULL,
                saved_at REAL NOT NULL,
                inactive_since REAL,
                expires_at REAL
            )
            """
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_active_rooms_expires_at "
            "ON active_rooms(expires_at)"
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS selfie_uploads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                room_code TEXT NOT NULL,
                game_started_at REAL,
                player_id TEXT NOT NULL,
                player_name TEXT NOT NULL,
                image_sha256 TEXT NOT NULL,
                storage_name TEXT NOT NULL,
                byte_count INTEGER NOT NULL
            )
            """
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_selfie_uploads_created_at "
            "ON selfie_uploads(created_at)"
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS research_streams (
                stream_id TEXT PRIMARY KEY,
                stream_type TEXT NOT NULL,
                party_id TEXT,
                room_code TEXT,
                game_id TEXT,
                created_at TEXT NOT NULL,
                last_event_at TEXT NOT NULL,
                next_sequence_no INTEGER NOT NULL DEFAULT 1,
                event_count INTEGER NOT NULL DEFAULT 0,
                first_event_hash TEXT,
                last_event_hash TEXT,
                last_state_hash TEXT
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS research_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id TEXT NOT NULL UNIQUE,
                stream_id TEXT NOT NULL,
                stream_type TEXT NOT NULL,
                sequence_no INTEGER NOT NULL,
                occurred_at TEXT NOT NULL,
                recorded_at TEXT NOT NULL,
                schema_version TEXT NOT NULL,
                app_version TEXT NOT NULL,
                party_id TEXT,
                room_code TEXT,
                game_id TEXT,
                source TEXT NOT NULL,
                category TEXT NOT NULL,
                event_type TEXT NOT NULL,
                visibility TEXT NOT NULL,
                actor_type TEXT NOT NULL,
                actor_id TEXT,
                subject_id TEXT,
                phase TEXT,
                mission_num INTEGER,
                proposal_attempt INTEGER,
                game_elapsed_ms INTEGER,
                phase_elapsed_ms INTEGER,
                client_session_id TEXT,
                client_event_id TEXT,
                client_sequence INTEGER,
                client_occurred_at TEXT,
                payload_json TEXT NOT NULL,
                state_json TEXT,
                state_hash TEXT,
                previous_event_hash TEXT,
                event_hash TEXT NOT NULL,
                event_json TEXT NOT NULL,
                FOREIGN KEY(stream_id) REFERENCES research_streams(stream_id)
                    ON DELETE CASCADE,
                UNIQUE(stream_id, sequence_no)
            )
            """
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_research_events_game "
            "ON research_events(game_id, sequence_no)"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_research_events_party "
            "ON research_events(party_id, id)"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_research_events_subject "
            "ON research_events(subject_id, occurred_at)"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_research_events_type "
            "ON research_events(event_type, occurred_at)"
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS research_games (
                game_id TEXT PRIMARY KEY,
                party_id TEXT NOT NULL,
                room_code TEXT NOT NULL,
                schema_version TEXT NOT NULL,
                ruleset_version TEXT NOT NULL,
                app_version TEXT NOT NULL,
                status TEXT NOT NULL,
                started_at TEXT NOT NULL,
                started_at_unix REAL NOT NULL,
                ended_at TEXT,
                ended_at_unix REAL,
                player_count INTEGER NOT NULL,
                human_count INTEGER NOT NULL,
                spectator_count_at_start INTEGER NOT NULL,
                settings_json TEXT NOT NULL,
                role_set_json TEXT NOT NULL,
                winner TEXT,
                win_reason TEXT,
                wall_duration_ms INTEGER,
                active_duration_ms INTEGER,
                mission_count INTEGER NOT NULL DEFAULT 0,
                proposal_count INTEGER NOT NULL DEFAULT 0,
                successful_missions INTEGER NOT NULL DEFAULT 0,
                failed_missions INTEGER NOT NULL DEFAULT 0,
                assassination_target_player_id TEXT,
                initial_state_json TEXT NOT NULL,
                initial_state_hash TEXT NOT NULL,
                final_state_json TEXT,
                final_state_hash TEXT,
                abandonment_reason TEXT
            )
            """
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_research_games_started "
            "ON research_games(started_at_unix)"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_research_games_party "
            "ON research_games(party_id, started_at_unix)"
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS research_participants (
                game_id TEXT NOT NULL,
                participant_id TEXT NOT NULL,
                participant_type TEXT NOT NULL,
                subject_id TEXT,
                display_name TEXT NOT NULL,
                seat_index INTEGER,
                role TEXT,
                team TEXT,
                is_bot INTEGER NOT NULL DEFAULT 0,
                is_host_player INTEGER NOT NULL DEFAULT 0,
                color_index INTEGER,
                avatar_index INTEGER,
                avatar_source TEXT,
                selfie_sha256 TEXT,
                vision_mode TEXT,
                first_seen_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                won INTEGER,
                PRIMARY KEY(game_id, participant_id),
                FOREIGN KEY(game_id) REFERENCES research_games(game_id)
                    ON DELETE CASCADE
            )
            """
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_research_participants_subject "
            "ON research_participants(subject_id, game_id)"
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS research_client_sessions (
                client_session_id TEXT PRIMARY KEY,
                subject_id TEXT,
                actor_type TEXT NOT NULL,
                actor_id TEXT,
                page TEXT,
                party_id TEXT,
                game_id TEXT,
                started_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                first_client_occurred_at TEXT,
                last_client_occurred_at TEXT,
                last_client_sequence INTEGER,
                event_count INTEGER NOT NULL DEFAULT 0,
                initial_context_json TEXT NOT NULL
            )
            """
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_research_sessions_subject "
            "ON research_client_sessions(subject_id, started_at)"
        )
        # Analysis views keep the immutable event stream as the source of truth
        # while exposing one-row-per-decision facts to SQL/notebook users.
        connection.execute(
            """
            CREATE VIEW IF NOT EXISTS research_proposal_facts AS
            SELECT p.game_id,
                   p.sequence_no AS proposed_sequence_no,
                   p.occurred_at AS proposed_at,
                   p.mission_num,
                   p.proposal_attempt,
                   p.actor_id AS leader_player_id,
                   CAST(json_extract(p.payload_json, '$.decision_ms') AS INTEGER)
                       AS decision_ms,
                   CAST(json_extract(p.payload_json, '$.team_size') AS INTEGER)
                       AS team_size,
                   json_extract(p.payload_json, '$.team_ids') AS team_ids_json,
                   CAST(json_extract(v.payload_json, '$.approve_count') AS INTEGER)
                       AS approve_count,
                   CAST(json_extract(v.payload_json, '$.reject_count') AS INTEGER)
                       AS reject_count,
                   CAST(json_extract(v.payload_json, '$.approved') AS INTEGER)
                       AS approved,
                   v.sequence_no AS resolved_sequence_no,
                   v.occurred_at AS resolved_at
            FROM research_events AS p
            LEFT JOIN research_events AS v
              ON v.game_id = p.game_id
             AND v.mission_num = p.mission_num
             AND v.proposal_attempt = p.proposal_attempt
             AND v.event_type = 'team_vote'
            WHERE p.event_type = 'team_proposal_submitted'
            """
        )
        connection.execute(
            """
            CREATE VIEW IF NOT EXISTS research_team_member_facts AS
            SELECT p.game_id, p.mission_num, p.proposal_attempt,
                   p.actor_id AS leader_player_id,
                   members.value AS selected_player_id,
                   p.sequence_no AS proposed_sequence_no
            FROM research_events AS p,
                 json_each(p.payload_json, '$.team_ids') AS members
            WHERE p.event_type = 'team_proposal_submitted'
            """
        )
        connection.execute(
            """
            CREATE VIEW IF NOT EXISTS research_vote_facts AS
            SELECT game_id, mission_num, proposal_attempt,
                   actor_id AS player_id, sequence_no, occurred_at,
                   json_extract(payload_json, '$.choice') AS choice,
                   CAST(json_extract(payload_json, '$.decision_ms') AS INTEGER)
                       AS decision_ms
            FROM research_events
            WHERE event_type = 'vote_submitted'
            """
        )
        connection.execute(
            """
            CREATE VIEW IF NOT EXISTS research_mission_card_facts AS
            SELECT game_id, mission_num, actor_id AS player_id,
                   sequence_no, occurred_at,
                   json_extract(payload_json, '$.card') AS card,
                   CAST(json_extract(payload_json, '$.decision_ms') AS INTEGER)
                       AS decision_ms
            FROM research_events
            WHERE event_type = 'mission_card_submitted'
            """
        )
        connection.execute(
            """
            CREATE VIEW IF NOT EXISTS research_mission_facts AS
            SELECT game_id, mission_num, sequence_no AS completed_sequence_no,
                   occurred_at AS completed_at,
                   json_extract(payload_json, '$.leader_name') AS leader_name,
                   json_extract(payload_json, '$.team') AS team_names_json,
                   CAST(json_extract(payload_json, '$.success_count') AS INTEGER)
                       AS success_count,
                   CAST(json_extract(payload_json, '$.fail_count') AS INTEGER)
                       AS fail_count,
                   CAST(json_extract(payload_json, '$.passed') AS INTEGER) AS passed
            FROM research_events
            WHERE event_type = 'mission_completed' AND source = 'gameplay'
            """
        )
        connection.execute(
            """
            CREATE VIEW IF NOT EXISTS research_assassination_facts AS
            SELECT game_id, actor_id AS assassin_player_id,
                   json_extract(payload_json, '$.target_player_id')
                       AS target_player_id,
                   CAST(json_extract(payload_json, '$.was_merlin') AS INTEGER)
                       AS was_merlin,
                   CAST(json_extract(payload_json, '$.decision_ms') AS INTEGER)
                       AS decision_ms,
                   occurred_at, sequence_no
            FROM research_events
            WHERE event_type = 'assassination_submitted'
            """
        )
        connection.execute(
            """
            CREATE VIEW IF NOT EXISTS research_spectrum_rating_facts AS
            SELECT e.game_id, e.mission_num, e.proposal_attempt,
                   e.actor_id AS rater_player_id,
                   positions.key AS target_player_id,
                   CAST(json_extract(positions.value, '$.x') AS REAL) AS x,
                   CAST(json_extract(positions.value, '$.y') AS REAL) AS y,
                   e.occurred_at, e.sequence_no
            FROM research_events AS e,
                 json_each(e.payload_json, '$.positions') AS positions
            WHERE e.event_type = 'spectrum_ratings_updated'
            """
        )
        connection.execute(
            """
            CREATE VIEW IF NOT EXISTS research_phase_facts AS
            WITH phase_events AS (
                SELECT game_id, sequence_no, occurred_at, phase,
                       mission_num, proposal_attempt, game_elapsed_ms,
                       phase_elapsed_ms, event_type, payload_json
                FROM research_events
                WHERE event_type IN (
                    'night_phase_started', 'round_started',
                    'discussion_started', 'proposal_started',
                    'team_vote_started', 'vote_reveal_started',
                    'mission_started', 'mission_reveal_started',
                    'assassin_phase_started'
                )
            )
            SELECT *,
                   LEAD(game_elapsed_ms) OVER (
                       PARTITION BY game_id ORDER BY sequence_no
                   ) - game_elapsed_ms AS observed_duration_ms
            FROM phase_events
            """
        )
        connection.execute(
            """
            CREATE VIEW IF NOT EXISTS research_player_game_stats AS
            SELECT p.game_id, p.participant_id AS player_id, p.subject_id,
                   p.display_name, p.seat_index, p.role, p.team, p.is_bot,
                   p.is_host_player, p.won, g.status, g.winner,
                   g.active_duration_ms,
                   SUM(CASE WHEN e.event_type = 'vote_submitted' THEN 1 ELSE 0 END)
                       AS votes_cast,
                   SUM(CASE WHEN e.event_type = 'vote_submitted'
                                  AND json_extract(e.payload_json, '$.choice') = 'approve'
                            THEN 1 ELSE 0 END) AS approve_votes,
                   AVG(CASE WHEN e.event_type = 'vote_submitted'
                            THEN CAST(json_extract(e.payload_json, '$.decision_ms') AS INTEGER)
                       END) AS average_vote_decision_ms,
                   SUM(CASE WHEN e.event_type = 'team_proposal_submitted'
                            THEN 1 ELSE 0 END) AS proposals_led,
                   AVG(CASE WHEN e.event_type = 'team_proposal_submitted'
                            THEN CAST(json_extract(e.payload_json, '$.decision_ms') AS INTEGER)
                       END) AS average_proposal_decision_ms,
                   SUM(CASE WHEN e.event_type = 'mission_card_submitted'
                            THEN 1 ELSE 0 END) AS missions_joined,
                   SUM(CASE WHEN e.event_type = 'mission_card_submitted'
                                  AND json_extract(e.payload_json, '$.card') = 'fail'
                            THEN 1 ELSE 0 END) AS fail_cards,
                   AVG(CASE WHEN e.event_type = 'mission_card_submitted'
                            THEN CAST(json_extract(e.payload_json, '$.decision_ms') AS INTEGER)
                       END) AS average_mission_decision_ms,
                   SUM(CASE WHEN e.event_type = 'chat_sent' THEN 1 ELSE 0 END)
                       AS chat_messages,
                   SUM(CASE WHEN e.event_type = 'player_disconnected' THEN 1 ELSE 0 END)
                       AS disconnects,
                   SUM(CASE WHEN e.event_type = 'player_reconnected' THEN 1 ELSE 0 END)
                       AS reconnects
            FROM research_participants AS p
            JOIN research_games AS g ON g.game_id = p.game_id
            LEFT JOIN research_events AS e
              ON e.game_id = p.game_id AND e.actor_id = p.participant_id
            WHERE p.participant_type = 'player'
            GROUP BY p.game_id, p.participant_id
            """
        )
        connection.commit()
        self._initialized = True

    def initialize(self) -> None:
        with self._lock, self._connect() as connection:
            self._initialize(connection)

    @staticmethod
    def _database_bytes(connection: sqlite3.Connection) -> int:
        page_count = connection.execute("PRAGMA page_count").fetchone()[0]
        page_size = connection.execute("PRAGMA page_size").fetchone()[0]
        return page_count * page_size

    def _prune(self, connection: sqlite3.Connection) -> None:
        while self._database_bytes(connection) > self.prune_to_bytes:
            chat_cursor = connection.execute(
                """
                DELETE FROM chat_messages
                WHERE id IN (
                    SELECT id FROM chat_messages ORDER BY id LIMIT 100000
                )
                """
            )
            event_cursor = connection.execute(
                """
                DELETE FROM game_events
                WHERE id IN (
                    SELECT id FROM game_events ORDER BY id LIMIT 100000
                )
                """
            )
            product_cursor = connection.execute(
                """
                DELETE FROM product_events
                WHERE id IN (
                    SELECT id FROM product_events ORDER BY id LIMIT 100000
                )
                """
            )
            # Research streams are an integrity-chained unit.  Never trim a
            # prefix and leave a game that looks replayable but is not.  Once
            # the legacy archives have yielded space, remove one entire oldest
            # terminal game (or orphaned party stream) at a time.
            research_pruned = False
            if (
                chat_cursor.rowcount == 0
                and event_cursor.rowcount == 0
                and product_cursor.rowcount == 0
            ):
                oldest_game = connection.execute(
                    """
                    SELECT game_id FROM research_games
                    WHERE status IN ('completed', 'abandoned', 'expired')
                    ORDER BY COALESCE(ended_at_unix, started_at_unix), game_id
                    LIMIT 1
                    """
                ).fetchone()
                if oldest_game:
                    game_id = oldest_game["game_id"]
                    connection.execute(
                        "DELETE FROM research_streams WHERE stream_id = ?", (game_id,)
                    )
                    connection.execute(
                        "DELETE FROM research_games WHERE game_id = ?", (game_id,)
                    )
                    research_pruned = True
                else:
                    orphaned_party = connection.execute(
                        """
                        SELECT stream_id FROM research_streams
                        WHERE stream_type = 'party'
                          AND room_code NOT IN (SELECT room_code FROM active_rooms)
                        ORDER BY last_event_at, stream_id
                        LIMIT 1
                        """
                    ).fetchone()
                    if orphaned_party:
                        connection.execute(
                            "DELETE FROM research_streams WHERE stream_id = ?",
                            (orphaned_party["stream_id"],),
                        )
                        research_pruned = True
            connection.commit()
            if (
                chat_cursor.rowcount == 0
                and event_cursor.rowcount == 0
                and product_cursor.rowcount == 0
                and not research_pruned
            ):
                break

    @staticmethod
    def _timestamp_text(created_at: datetime | None = None) -> str:
        timestamp = created_at or datetime.now(timezone.utc)
        if timestamp.tzinfo is None:
            timestamp = timestamp.replace(tzinfo=timezone.utc)
        return timestamp.astimezone(timezone.utc).isoformat(timespec="seconds").replace(
            "+00:00", "Z"
        )

    def save(
        self,
        *,
        room_code: str,
        game_started_at: float | None,
        player_name: str,
        message: str,
        message_id: str | None = None,
        party_id: str | None = None,
        game_id: str | None = None,
        actor_type: str | None = None,
        actor_id: str | None = None,
        subject_id: str | None = None,
        phase: str | None = None,
        mission_num: int | None = None,
        proposal_attempt: int | None = None,
        created_at: datetime | None = None,
    ) -> None:
        timestamp_text = self._timestamp_text(created_at)
        message_id = message_id or str(uuid.uuid4())
        message_length = len(message)
        word_count = len(message.split())
        contains_url = int("http://" in message.lower() or "https://" in message.lower())
        values = (
            timestamp_text,
            room_code.upper(),
            game_started_at,
            player_name,
            message,
            message_id,
            party_id,
            game_id,
            actor_type,
            actor_id,
            subject_id,
            phase,
            mission_num,
            proposal_attempt,
            message_length,
            word_count,
            contains_url,
        )
        with self._lock, self._connect() as connection:
            self._initialize(connection)
            if self._database_bytes(connection) >= self.prune_at_bytes:
                self._prune(connection)
            try:
                connection.execute(
                    """
                    INSERT INTO chat_messages (
                        created_at, room_code, game_started_at, player_name, message,
                        message_id, party_id, game_id, actor_type, actor_id,
                        subject_id, phase, mission_num, proposal_attempt,
                        message_length, word_count, contains_url
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    values,
                )
                connection.commit()
            except sqlite3.OperationalError as error:
                if "full" not in str(error).lower():
                    raise
                connection.rollback()
                self._prune(connection)
                connection.execute(
                    """
                    INSERT INTO chat_messages (
                        created_at, room_code, game_started_at, player_name, message,
                        message_id, party_id, game_id, actor_type, actor_id,
                        subject_id, phase, mission_num, proposal_attempt,
                        message_length, word_count, contains_url
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    values,
                )
                connection.commit()

    def save_game_event(
        self,
        *,
        room_code: str,
        game_started_at: float,
        event_type: str,
        payload: dict,
        created_at: datetime | None = None,
    ) -> None:
        timestamp_text = self._timestamp_text(created_at)
        payload_json = json.dumps(payload, separators=(",", ":"), sort_keys=True)
        with self._lock, self._connect() as connection:
            self._initialize(connection)
            if self._database_bytes(connection) >= self.prune_at_bytes:
                self._prune(connection)
            try:
                connection.execute(
                    """
                    INSERT INTO game_events (
                        created_at, room_code, game_started_at, event_type, payload_json
                    ) VALUES (?, ?, ?, ?, ?)
                    """,
                    (timestamp_text, room_code.upper(), game_started_at, event_type, payload_json),
                )
                connection.commit()
            except sqlite3.OperationalError as error:
                if "full" not in str(error).lower():
                    raise
                connection.rollback()
                self._prune(connection)
                connection.execute(
                    """
                    INSERT INTO game_events (
                        created_at, room_code, game_started_at, event_type, payload_json
                    ) VALUES (?, ?, ?, ?, ?)
                    """,
                    (timestamp_text, room_code.upper(), game_started_at, event_type, payload_json),
                )
                connection.commit()

    def save_product_event(
        self,
        *,
        event_id: str,
        schema_version: int,
        app_version: str,
        event_type: str,
        actor_type: str,
        payload: dict,
        party_id: str | None = None,
        room_code: str | None = None,
        game_id: str | None = None,
        game_started_at: float | None = None,
        actor_id: str | None = None,
        analytics_id: str | None = None,
        phase: str | None = None,
        mission_num: int | None = None,
        proposal_attempt: int | None = None,
        created_at: datetime | None = None,
    ) -> None:
        """Save a bounded, token-free product event envelope."""
        timestamp = created_at or datetime.now(timezone.utc)
        if timestamp.tzinfo is None:
            timestamp = timestamp.replace(tzinfo=timezone.utc)
        timestamp_text = timestamp.astimezone(timezone.utc).isoformat(
            timespec="milliseconds"
        ).replace("+00:00", "Z")
        payload_json = json.dumps(payload, separators=(",", ":"), sort_keys=True)
        if len(payload_json.encode("utf-8")) > 4096:
            raise ValueError("product event payload exceeds 4096 bytes")
        with self._lock, self._connect() as connection:
            self._initialize(connection)
            if self._database_bytes(connection) >= self.prune_at_bytes:
                self._prune(connection)
            connection.execute(
                """
                INSERT OR IGNORE INTO product_events (
                    event_id, created_at, schema_version, app_version,
                    party_id, room_code, game_id, game_started_at,
                    actor_type, actor_id, analytics_id, event_type, phase,
                    mission_num, proposal_attempt, payload_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event_id,
                    timestamp_text,
                    int(schema_version),
                    app_version,
                    party_id,
                    room_code.upper() if room_code else None,
                    game_id,
                    game_started_at,
                    actor_type,
                    actor_id,
                    analytics_id,
                    event_type,
                    phase,
                    mission_num,
                    proposal_attempt,
                    payload_json,
                ),
            )
            connection.commit()

    def product_events(
        self,
        *,
        game_id: str | None = None,
        party_id: str | None = None,
        limit: int = 10000,
    ) -> list[sqlite3.Row]:
        clauses = []
        parameters: list[object] = []
        if game_id:
            clauses.append("game_id = ?")
            parameters.append(game_id)
        if party_id:
            clauses.append("party_id = ?")
            parameters.append(party_id)
        parameters.append(max(1, min(int(limit), 100000)))
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        with self._lock, self._connect() as connection:
            self._initialize(connection)
            return list(
                connection.execute(
                    f"""
                    SELECT event_id, created_at, schema_version, app_version,
                           party_id, room_code, game_id, game_started_at,
                           actor_type, actor_id, analytics_id, event_type,
                           phase, mission_num, proposal_attempt, payload_json
                    FROM product_events{where}
                    ORDER BY id
                    LIMIT ?
                    """,
                    parameters,
                )
            )

    def save_research_event(
        self,
        *,
        stream_id: str,
        stream_type: str,
        app_version: str,
        event_type: str,
        source: str,
        category: str,
        visibility: str,
        actor_type: str,
        payload: dict,
        party_id: str | None = None,
        room_code: str | None = None,
        game_id: str | None = None,
        actor_id: str | None = None,
        subject_id: str | None = None,
        phase: str | None = None,
        mission_num: int | None = None,
        proposal_attempt: int | None = None,
        game_elapsed_ms: int | None = None,
        phase_elapsed_ms: int | None = None,
        state: dict | None = None,
        client: dict | None = None,
        event_id: str | None = None,
        occurred_at: str | None = None,
    ) -> dict | None:
        """Append one ordered, hash-chained event to a party or game stream."""
        if stream_type not in {"client", "party", "game"}:
            raise ValueError("research stream_type must be client, party, or game")
        if visibility not in {"public", "private", "research_secret"}:
            raise ValueError("invalid research event visibility")
        if not isinstance(payload, dict):
            raise ValueError("research payload must be an object")
        payload_json = canonical_json(payload)
        if len(payload_json.encode("utf-8")) > MAX_RESEARCH_PAYLOAD_BYTES:
            raise ValueError(
                f"research payload exceeds {MAX_RESEARCH_PAYLOAD_BYTES} bytes"
            )
        state_json = canonical_json(state) if state is not None else None
        if (
            source == "state_checkpoint" or event_type == "state_checkpoint"
        ) and state is None:
            raise ValueError("state_checkpoint requires a replay state")
        if state_json and len(state_json.encode("utf-8")) > MAX_REPLAY_STATE_BYTES:
            raise ValueError(f"replay state exceeds {MAX_REPLAY_STATE_BYTES} bytes")
        state_hash = sha256_json(state) if state is not None else None
        event_id = event_id or str(uuid.uuid4())
        recorded_at = utc_timestamp()
        occurred_at = occurred_at or recorded_at
        client = dict(client or {})
        client_session_id = client.get("session_id")
        client_event_id = client.get("event_id")
        client_sequence = client.get("sequence")
        client_occurred_at = client.get("occurred_at")

        with self._lock, self._connect() as connection:
            self._initialize(connection)
            if self._database_bytes(connection) >= self.prune_at_bytes:
                self._prune(connection)
            duplicate = connection.execute(
                "SELECT stream_id, sequence_no, event_hash FROM research_events "
                "WHERE event_id = ?",
                (event_id,),
            ).fetchone()
            if duplicate:
                return dict(duplicate)
            stream = connection.execute(
                "SELECT * FROM research_streams WHERE stream_id = ?", (stream_id,)
            ).fetchone()
            if stream is None:
                connection.execute(
                    """
                    INSERT INTO research_streams (
                        stream_id, stream_type, party_id, room_code, game_id,
                        created_at, last_event_at, next_sequence_no, event_count
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)
                    """,
                    (
                        stream_id,
                        stream_type,
                        party_id,
                        room_code.upper() if room_code else None,
                        game_id,
                        recorded_at,
                        recorded_at,
                    ),
                )
                sequence_no = 1
                previous_event_hash = None
                last_state_hash = None
            else:
                if stream["stream_type"] != stream_type:
                    raise ValueError("research stream type changed")
                sequence_no = int(stream["next_sequence_no"])
                previous_event_hash = stream["last_event_hash"]
                last_state_hash = stream["last_state_hash"]
            if (
                (source == "state_checkpoint" or event_type == "state_checkpoint")
                and state_hash == last_state_hash
            ):
                return None
            document = build_event_document(
                event_id=event_id,
                stream_id=stream_id,
                stream_type=stream_type,
                sequence_no=sequence_no,
                occurred_at=occurred_at,
                recorded_at=recorded_at,
                app_version=app_version,
                party_id=party_id,
                room_code=room_code.upper() if room_code else None,
                game_id=game_id,
                source=source,
                category=category,
                event_type=event_type,
                visibility=visibility,
                actor_type=actor_type,
                actor_id=actor_id,
                subject_id=subject_id,
                phase=phase,
                mission_num=mission_num,
                proposal_attempt=proposal_attempt,
                game_elapsed_ms=game_elapsed_ms,
                phase_elapsed_ms=phase_elapsed_ms,
                payload=payload,
                state_hash=state_hash,
                previous_event_hash=previous_event_hash,
                client=client or None,
            )
            event_json = canonical_json(document)
            event_hash = chained_event_hash(document)
            connection.execute(
                """
                INSERT INTO research_events (
                    event_id, stream_id, stream_type, sequence_no,
                    occurred_at, recorded_at, schema_version, app_version,
                    party_id, room_code, game_id, source, category, event_type,
                    visibility, actor_type, actor_id, subject_id, phase,
                    mission_num, proposal_attempt, game_elapsed_ms,
                    phase_elapsed_ms, client_session_id, client_event_id,
                    client_sequence, client_occurred_at, payload_json,
                    state_json, state_hash, previous_event_hash, event_hash,
                    event_json
                ) VALUES (
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                )
                """,
                (
                    event_id,
                    stream_id,
                    stream_type,
                    sequence_no,
                    occurred_at,
                    recorded_at,
                    RESEARCH_SPEC_VERSION,
                    app_version,
                    party_id,
                    room_code.upper() if room_code else None,
                    game_id,
                    source,
                    category,
                    event_type,
                    visibility,
                    actor_type,
                    actor_id,
                    subject_id,
                    phase,
                    mission_num,
                    proposal_attempt,
                    game_elapsed_ms,
                    phase_elapsed_ms,
                    client_session_id,
                    client_event_id,
                    client_sequence,
                    client_occurred_at,
                    payload_json,
                    state_json,
                    state_hash,
                    previous_event_hash,
                    event_hash,
                    event_json,
                ),
            )
            connection.execute(
                """
                UPDATE research_streams
                SET last_event_at = ?, next_sequence_no = ?,
                    event_count = event_count + 1,
                    first_event_hash = COALESCE(first_event_hash, ?),
                    last_event_hash = ?,
                    last_state_hash = COALESCE(?, last_state_hash),
                    party_id = COALESCE(?, party_id),
                    room_code = COALESCE(?, room_code),
                    game_id = COALESCE(?, game_id)
                WHERE stream_id = ?
                """,
                (
                    recorded_at,
                    sequence_no + 1,
                    event_hash,
                    event_hash,
                    state_hash,
                    party_id,
                    room_code.upper() if room_code else None,
                    game_id,
                    stream_id,
                ),
            )
            if client_session_id:
                context_json = canonical_json(client.get("context", {}))
                connection.execute(
                    """
                    INSERT INTO research_client_sessions (
                        client_session_id, subject_id, actor_type, actor_id,
                        page, party_id, game_id, started_at, last_seen_at,
                        first_client_occurred_at, last_client_occurred_at,
                        last_client_sequence, event_count, initial_context_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
                    ON CONFLICT(client_session_id) DO UPDATE SET
                        subject_id = COALESCE(excluded.subject_id, subject_id),
                        actor_type = excluded.actor_type,
                        actor_id = COALESCE(excluded.actor_id, actor_id),
                        party_id = COALESCE(excluded.party_id, party_id),
                        game_id = COALESCE(excluded.game_id, game_id),
                        last_seen_at = excluded.last_seen_at,
                        last_client_occurred_at = COALESCE(
                            excluded.last_client_occurred_at,
                            last_client_occurred_at
                        ),
                        last_client_sequence = CASE
                            WHEN excluded.last_client_sequence IS NULL
                                THEN last_client_sequence
                            WHEN last_client_sequence IS NULL
                                THEN excluded.last_client_sequence
                            ELSE MAX(last_client_sequence, excluded.last_client_sequence)
                        END,
                        event_count = event_count + 1
                    """,
                    (
                        client_session_id,
                        subject_id,
                        actor_type,
                        actor_id,
                        client.get("page"),
                        party_id,
                        game_id,
                        recorded_at,
                        recorded_at,
                        client_occurred_at,
                        client_occurred_at,
                        client_sequence,
                        context_json,
                    ),
                )
            connection.commit()
            return {
                "stream_id": stream_id,
                "sequence_no": sequence_no,
                "event_hash": event_hash,
                "state_hash": state_hash,
            }

    def start_research_game(
        self, *, game: dict, participants: list[dict]
    ) -> None:
        """Create the normalized game and participant dimensions idempotently."""
        state_json = canonical_json(game["initial_state"])
        state_hash = sha256_json(game["initial_state"])
        with self._lock, self._connect() as connection:
            self._initialize(connection)
            connection.execute(
                """
                INSERT INTO research_games (
                    game_id, party_id, room_code, schema_version,
                    ruleset_version, app_version, status, started_at,
                    started_at_unix, player_count, human_count,
                    spectator_count_at_start, settings_json, role_set_json,
                    initial_state_json, initial_state_hash
                ) VALUES (?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(game_id) DO UPDATE SET
                    app_version = excluded.app_version,
                    player_count = excluded.player_count,
                    human_count = excluded.human_count,
                    spectator_count_at_start = excluded.spectator_count_at_start,
                    settings_json = excluded.settings_json,
                    role_set_json = excluded.role_set_json
                """,
                (
                    game["game_id"],
                    game["party_id"],
                    game["room_code"].upper(),
                    RESEARCH_SPEC_VERSION,
                    game["ruleset_version"],
                    game["app_version"],
                    game["started_at"],
                    float(game["started_at_unix"]),
                    int(game["player_count"]),
                    int(game["human_count"]),
                    int(game["spectator_count"]),
                    canonical_json(game["settings"]),
                    canonical_json(game["role_set"]),
                    state_json,
                    state_hash,
                ),
            )
            for participant in participants:
                self._upsert_research_participant(connection, participant)
            connection.commit()

    @staticmethod
    def _upsert_research_participant(
        connection: sqlite3.Connection, participant: dict
    ) -> None:
        connection.execute(
            """
            INSERT INTO research_participants (
                game_id, participant_id, participant_type, subject_id,
                display_name, seat_index, role, team, is_bot,
                is_host_player, color_index, avatar_index, avatar_source,
                selfie_sha256, vision_mode, first_seen_at, last_seen_at, won
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(game_id, participant_id) DO UPDATE SET
                subject_id = COALESCE(excluded.subject_id, subject_id),
                display_name = excluded.display_name,
                seat_index = excluded.seat_index,
                role = COALESCE(excluded.role, role),
                team = COALESCE(excluded.team, team),
                is_bot = excluded.is_bot,
                is_host_player = excluded.is_host_player,
                color_index = excluded.color_index,
                avatar_index = excluded.avatar_index,
                avatar_source = excluded.avatar_source,
                selfie_sha256 = COALESCE(excluded.selfie_sha256, selfie_sha256),
                vision_mode = COALESCE(excluded.vision_mode, vision_mode),
                last_seen_at = excluded.last_seen_at,
                won = COALESCE(excluded.won, won)
            """,
            (
                participant["game_id"],
                participant["participant_id"],
                participant["participant_type"],
                participant.get("subject_id"),
                participant["display_name"],
                participant.get("seat_index"),
                participant.get("role"),
                participant.get("team"),
                int(bool(participant.get("is_bot"))),
                int(bool(participant.get("is_host_player"))),
                participant.get("color_index"),
                participant.get("avatar_index"),
                participant.get("avatar_source"),
                participant.get("selfie_sha256"),
                participant.get("vision_mode"),
                participant["first_seen_at"],
                participant["last_seen_at"],
                (
                    int(bool(participant["won"]))
                    if participant.get("won") is not None
                    else None
                ),
            ),
        )

    def upsert_research_participant(self, participant: dict) -> None:
        with self._lock, self._connect() as connection:
            self._initialize(connection)
            self._upsert_research_participant(connection, participant)
            connection.commit()

    def finalize_research_game(self, *, game: dict, participants: list[dict]) -> None:
        """Freeze outcome facts and the terminal replay state."""
        final_state_json = canonical_json(game["final_state"])
        final_state_hash = sha256_json(game["final_state"])
        with self._lock, self._connect() as connection:
            self._initialize(connection)
            connection.execute(
                """
                UPDATE research_games
                SET status = ?, ended_at = ?, ended_at_unix = ?, winner = ?,
                    win_reason = ?, wall_duration_ms = ?, active_duration_ms = ?,
                    mission_count = ?, proposal_count = ?,
                    successful_missions = ?, failed_missions = ?,
                    assassination_target_player_id = ?, final_state_json = ?,
                    final_state_hash = ?, abandonment_reason = ?
                WHERE game_id = ?
                  AND status = 'in_progress'
                """,
                (
                    game["status"],
                    game["ended_at"],
                    float(game["ended_at_unix"]),
                    game.get("winner"),
                    game.get("win_reason"),
                    int(game["wall_duration_ms"]),
                    int(game["active_duration_ms"]),
                    int(game["mission_count"]),
                    int(game["proposal_count"]),
                    int(game["successful_missions"]),
                    int(game["failed_missions"]),
                    game.get("assassination_target_player_id"),
                    final_state_json,
                    final_state_hash,
                    game.get("abandonment_reason"),
                    game["game_id"],
                ),
            )
            for participant in participants:
                self._upsert_research_participant(connection, participant)
            connection.commit()

    def research_games(
        self, *, status: str | None = None, limit: int = 10000
    ) -> list[sqlite3.Row]:
        where = "WHERE status = ?" if status else ""
        parameters: list[object] = [status] if status else []
        parameters.append(max(1, min(int(limit), 100000)))
        with self._lock, self._connect() as connection:
            self._initialize(connection)
            return list(
                connection.execute(
                    f"SELECT * FROM research_games {where} "
                    "ORDER BY started_at_unix DESC LIMIT ?",
                    parameters,
                )
            )

    def research_game(self, game_id: str) -> sqlite3.Row | None:
        with self._lock, self._connect() as connection:
            self._initialize(connection)
            return connection.execute(
                "SELECT * FROM research_games WHERE game_id = ?", (game_id,)
            ).fetchone()

    def research_participants(
        self, game_id: str | None = None, *, subject_id: str | None = None
    ) -> list[sqlite3.Row]:
        clauses = []
        parameters: list[object] = []
        if game_id:
            clauses.append("game_id = ?")
            parameters.append(game_id)
        if subject_id:
            clauses.append("subject_id = ?")
            parameters.append(subject_id)
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        with self._lock, self._connect() as connection:
            self._initialize(connection)
            return list(
                connection.execute(
                    "SELECT * FROM research_participants"
                    + where
                    + " ORDER BY game_id, participant_type, seat_index, participant_id",
                    parameters,
                )
            )

    def research_events(
        self,
        *,
        game_id: str | None = None,
        stream_id: str | None = None,
        subject_id: str | None = None,
        event_type: str | None = None,
        limit: int = 100000,
    ) -> list[sqlite3.Row]:
        clauses = []
        parameters: list[object] = []
        for column, value in (
            ("game_id", game_id),
            ("stream_id", stream_id),
            ("subject_id", subject_id),
            ("event_type", event_type),
        ):
            if value:
                clauses.append(f"{column} = ?")
                parameters.append(value)
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        parameters.append(max(1, min(int(limit), 1_000_000)))
        with self._lock, self._connect() as connection:
            self._initialize(connection)
            return list(
                connection.execute(
                    "SELECT * FROM research_events"
                    + where
                    + " ORDER BY stream_id, sequence_no LIMIT ?",
                    parameters,
                )
            )

    def research_stream(self, stream_id: str) -> sqlite3.Row | None:
        with self._lock, self._connect() as connection:
            self._initialize(connection)
            return connection.execute(
                "SELECT * FROM research_streams WHERE stream_id = ?", (stream_id,)
            ).fetchone()

    def research_client_sessions(
        self, *, game_id: str | None = None, subject_id: str | None = None
    ) -> list[sqlite3.Row]:
        clauses = []
        parameters: list[object] = []
        if game_id:
            clauses.append("game_id = ?")
            parameters.append(game_id)
        if subject_id:
            clauses.append("subject_id = ?")
            parameters.append(subject_id)
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        with self._lock, self._connect() as connection:
            self._initialize(connection)
            return list(
                connection.execute(
                    "SELECT * FROM research_client_sessions"
                    + where
                    + " ORDER BY started_at, client_session_id",
                    parameters,
                )
            )

    def research_chat_messages(self, game_id: str) -> list[sqlite3.Row]:
        with self._lock, self._connect() as connection:
            self._initialize(connection)
            return list(
                connection.execute(
                    """
                    SELECT message_id, created_at, room_code, game_started_at,
                           party_id, game_id, actor_type, actor_id, subject_id,
                           player_name, phase, mission_num, proposal_attempt,
                           message, message_length, word_count, contains_url
                    FROM chat_messages
                    WHERE game_id = ?
                    ORDER BY id
                    """,
                    (game_id,),
                )
            )
    def save_selfie_reference(
        self,
        *,
        room_code: str,
        game_started_at: float | None,
        player_id: str,
        player_name: str,
        image_sha256: str,
        storage_name: str,
        byte_count: int,
        created_at: datetime | None = None,
    ) -> None:
        """Index a selfie stored outside the public web root."""
        timestamp_text = self._timestamp_text(created_at)
        with self._lock, self._connect() as connection:
            self._initialize(connection)
            if self._database_bytes(connection) >= self.prune_at_bytes:
                self._prune(connection)
            connection.execute(
                """
                INSERT INTO selfie_uploads (
                    created_at, room_code, game_started_at, player_id,
                    player_name, image_sha256, storage_name, byte_count
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    timestamp_text,
                    room_code.upper(),
                    game_started_at,
                    player_id,
                    player_name,
                    image_sha256,
                    storage_name,
                    int(byte_count),
                ),
            )
            connection.commit()

    def saved_selfies(self, limit: int = 1000) -> list[sqlite3.Row]:
        with self._lock, self._connect() as connection:
            self._initialize(connection)
            return list(
                connection.execute(
                    """
                    SELECT created_at, room_code, game_started_at, player_id,
                           player_name, image_sha256, storage_name, byte_count
                    FROM selfie_uploads
                    ORDER BY id DESC
                    LIMIT ?
                    """,
                    (max(1, min(int(limit), 10000)),),
                )
            )

    def save_room_snapshot(
        self,
        *,
        room_code: str,
        schema_version: int,
        state: dict,
        saved_at: float,
        inactive_since: float | None,
        expires_at: float | None,
    ) -> None:
        """Atomically upsert the latest resumable state for one live room."""
        state_json = json.dumps(state, separators=(",", ":"), sort_keys=True)
        with self._lock, self._connect() as connection:
            self._initialize(connection)
            if self._database_bytes(connection) >= self.prune_at_bytes:
                self._prune(connection)
            connection.execute(
                """
                INSERT INTO active_rooms (
                    room_code, schema_version, state_json, saved_at,
                    inactive_since, expires_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(room_code) DO UPDATE SET
                    schema_version = excluded.schema_version,
                    state_json = excluded.state_json,
                    saved_at = excluded.saved_at,
                    inactive_since = excluded.inactive_since,
                    expires_at = excluded.expires_at
                """,
                (
                    room_code.upper(),
                    int(schema_version),
                    state_json,
                    float(saved_at),
                    inactive_since,
                    expires_at,
                ),
            )
            connection.commit()

    def room_snapshots(self) -> list[sqlite3.Row]:
        with self._lock, self._connect() as connection:
            self._initialize(connection)
            return list(
                connection.execute(
                    """
                    SELECT room_code, schema_version, state_json, saved_at,
                           inactive_since, expires_at
                    FROM active_rooms
                    ORDER BY saved_at
                    """
                )
            )

    def delete_room_snapshot(self, room_code: str) -> None:
        with self._lock, self._connect() as connection:
            self._initialize(connection)
            connection.execute(
                "DELETE FROM active_rooms WHERE room_code = ?",
                (room_code.upper(),),
            )
            connection.commit()

    def saved_games(self, limit: int = 1000) -> list[sqlite3.Row]:
        with self._lock, self._connect() as connection:
            self._initialize(connection)
            return list(connection.execute(
                """
                SELECT room_code, game_started_at, min(created_at) AS started_at,
                       max(created_at) AS last_event_at, count(*) AS event_count
                FROM game_events
                GROUP BY room_code, game_started_at
                ORDER BY game_started_at DESC
                LIMIT ?
                """,
                (max(1, min(int(limit), 10000)),),
            ))

    def events_for_game(
        self, room_code: str, game_started_at: float, *, limit: int = 100000
    ) -> list[sqlite3.Row]:
        with self._lock, self._connect() as connection:
            self._initialize(connection)
            return list(connection.execute(
                """
                SELECT created_at, room_code, game_started_at, event_type, payload_json
                FROM game_events
                WHERE room_code = ? AND game_started_at = ?
                ORDER BY id
                LIMIT ?
                """,
                (room_code.upper(), float(game_started_at), max(1, min(int(limit), 100000))),
            ))

    def available_dates(self) -> list[tuple[str, int]]:
        with self._lock, self._connect() as connection:
            self._initialize(connection)
            return [
                (row["chat_date"], row["message_count"])
                for row in connection.execute(
                    """
                    SELECT substr(created_at, 1, 10) AS chat_date,
                           count(*) AS message_count
                    FROM chat_messages
                    GROUP BY chat_date
                    ORDER BY chat_date DESC
                    """
                )
            ]

    def messages_for_date(
        self, chat_date: date, *, room_code: str | None = None, limit: int = 5000
    ) -> list[sqlite3.Row]:
        start = datetime.combine(chat_date, time.min, tzinfo=timezone.utc)
        end = start + timedelta(days=1)
        parameters: list[object] = [
            start.isoformat(timespec="seconds").replace("+00:00", "Z"),
            end.isoformat(timespec="seconds").replace("+00:00", "Z"),
        ]
        room_clause = ""
        if room_code:
            room_clause = " AND room_code = ?"
            parameters.append(room_code.upper())
        parameters.append(max(1, min(int(limit), 100000)))
        with self._lock, self._connect() as connection:
            self._initialize(connection)
            return list(
                connection.execute(
                    f"""
                    SELECT created_at, room_code, game_started_at,
                           player_name, message
                    FROM chat_messages
                    WHERE created_at >= ? AND created_at < ?{room_clause}
                    ORDER BY id
                    LIMIT ?
                    """,
                    parameters,
                )
            )

    def recent_messages_for_game(
        self, room_code: str, game_started_at: float | None, *, limit: int = 30
    ) -> list[sqlite3.Row]:
        """Return the newest messages for one game in chronological order."""
        if game_started_at is None:
            return []
        bounded_limit = max(1, min(int(limit), 100))
        with self._lock, self._connect() as connection:
            self._initialize(connection)
            return list(
                connection.execute(
                    """
                    SELECT created_at, player_name, message
                    FROM (
                        SELECT id, created_at, player_name, message
                        FROM chat_messages
                        WHERE room_code = ? AND game_started_at = ?
                        ORDER BY id DESC
                        LIMIT ?
                    )
                    ORDER BY id
                    """,
                    (room_code.upper(), float(game_started_at), bounded_limit),
                )
            )


def configured_chat_store() -> ChatStore:
    requested_max = int(os.environ.get("CHAT_DB_MAX_BYTES", DEFAULT_MAX_BYTES))
    return ChatStore(
        os.environ.get("CHAT_DB_PATH", DEFAULT_DB_PATH),
        min(requested_max, HARD_MAX_BYTES),
    )
