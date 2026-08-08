import os
import json
import sqlite3
import threading
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path


DEFAULT_MAX_BYTES = 900 * 1024 * 1024
HARD_MAX_BYTES = 900 * 1024 * 1024
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
        return connection

    def _initialize(self, connection: sqlite3.Connection) -> None:
        if self._initialized:
            return
        connection.execute("PRAGMA page_size = 4096")
        connection.execute("PRAGMA auto_vacuum = FULL")
        page_size = connection.execute("PRAGMA page_size").fetchone()[0]
        max_pages = max(128, self.max_bytes // page_size)
        connection.execute(f"PRAGMA max_page_count = {max_pages}")
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
            "CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at "
            "ON chat_messages(created_at)"
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
            connection.commit()
            if chat_cursor.rowcount == 0 and event_cursor.rowcount == 0:
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
        created_at: datetime | None = None,
    ) -> None:
        timestamp_text = self._timestamp_text(created_at)
        with self._lock, self._connect() as connection:
            self._initialize(connection)
            if self._database_bytes(connection) >= self.prune_at_bytes:
                self._prune(connection)
            try:
                connection.execute(
                    """
                    INSERT INTO chat_messages (
                        created_at, room_code, game_started_at, player_name, message
                    ) VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        timestamp_text,
                        room_code,
                        game_started_at,
                        player_name,
                        message,
                    ),
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
                        created_at, room_code, game_started_at, player_name, message
                    ) VALUES (?, ?, ?, ?, ?)
                    """,
                    (timestamp_text, room_code, game_started_at, player_name, message),
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
