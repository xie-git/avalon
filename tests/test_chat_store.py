from datetime import date, datetime, timezone
import json

import pytest
import server
from chat_store import HARD_MAX_BYTES, ChatStore


def packets_for(client, name):
    return [
        packet["args"][0] for packet in client.get_received() if packet["name"] == name
    ]


def test_chat_store_queries_dates_rooms_and_senders(tmp_path):
    store = ChatStore(str(tmp_path / "chat.sqlite3"), max_bytes=1024 * 1024)
    store.initialize()
    store.save(
        room_code="ABCD",
        game_started_at=100.0,
        player_name="Arthur",
        message="For Camelot",
        created_at=datetime(2026, 8, 7, 12, 34, 56, tzinfo=timezone.utc),
    )
    store.save(
        room_code="WXYZ",
        game_started_at=200.0,
        player_name="Merlin",
        message="Trust me",
        created_at=datetime(2026, 8, 8, 1, 2, 3, tzinfo=timezone.utc),
    )

    assert store.available_dates() == [("2026-08-08", 1), ("2026-08-07", 1)]
    rows = store.messages_for_date(date(2026, 8, 7), room_code="abcd")
    assert [dict(row) for row in rows] == [
        {
            "created_at": "2026-08-07T12:34:56Z",
            "room_code": "ABCD",
            "game_started_at": 100.0,
            "player_name": "Arthur",
            "message": "For Camelot",
        }
    ]
    recent = store.recent_messages_for_game("ABCD", 100.0)
    assert [dict(row) for row in recent] == [
        {
            "created_at": "2026-08-07T12:34:56Z",
            "player_name": "Arthur",
            "message": "For Camelot",
        }
    ]


def test_chat_store_prunes_before_its_size_limit(tmp_path):
    database = tmp_path / "bounded.sqlite3"
    store = ChatStore(str(database), max_bytes=512 * 1024)
    store.initialize()
    for index in range(2000):
        store.save(
            room_code="ABCD",
            game_started_at=100.0,
            player_name="Arthur",
            message=f"{index:04d}-" + "x" * 500,
        )

    assert database.stat().st_size <= 512 * 1024
    rows = store.messages_for_date(datetime.now(timezone.utc).date(), limit=100000)
    assert 0 < len(rows) < 2000
    assert rows[-1]["message"].startswith("1999-")


def test_chat_store_enforces_two_and_a_half_gib_hard_limit(tmp_path):
    store = ChatStore(str(tmp_path / "bounded.sqlite3"), max_bytes=HARD_MAX_BYTES * 2)

    assert HARD_MAX_BYTES == 2_560 * 1024 * 1024
    assert store.max_bytes == HARD_MAX_BYTES
    with store._connect() as connection:
        page_size = connection.execute("PRAGMA page_size").fetchone()[0]
        max_page_count = connection.execute("PRAGMA max_page_count").fetchone()[0]
    assert page_size * max_page_count == HARD_MAX_BYTES


def test_game_events_share_database_and_can_be_replayed(tmp_path):
    store = ChatStore(str(tmp_path / "history.sqlite3"), max_bytes=1024 * 1024)
    store.initialize()
    store.save_game_event(
        room_code="abcd",
        game_started_at=123.5,
        event_type="mission_completed",
        payload={"mission_num": 1, "team": ["Arthur", "Merlin"], "fail_count": 0},
        created_at=datetime(2026, 8, 7, 12, 0, tzinfo=timezone.utc),
    )

    games = store.saved_games()
    assert len(games) == 1
    assert games[0]["room_code"] == "ABCD"
    events = store.events_for_game("abcd", 123.5)
    assert events[0]["event_type"] == "mission_completed"
    assert json.loads(events[0]["payload_json"])["team"] == ["Arthur", "Merlin"]


def test_product_events_have_versioned_envelopes_and_deduplicate(tmp_path):
    store = ChatStore(str(tmp_path / "analytics.sqlite3"), max_bytes=1024 * 1024)
    values = {
        "event_id": "event-1",
        "schema_version": 1,
        "app_version": "2026.08.24",
        "party_id": "party-1",
        "room_code": "abcd",
        "game_id": "game-1",
        "game_started_at": 123.5,
        "actor_type": "player",
        "actor_id": "player-1",
        "analytics_id": "11111111-1111-4111-8111-111111111111",
        "event_type": "vote_submitted",
        "phase": "TEAM_VOTE",
        "mission_num": 2,
        "proposal_attempt": 1,
        "payload": {"choice": "approve", "decision_ms": 1234},
    }
    store.save_product_event(**values)
    store.save_product_event(**values)

    rows = store.product_events(game_id="game-1")
    assert len(rows) == 1
    assert rows[0]["room_code"] == "ABCD"
    assert rows[0]["app_version"] == "2026.08.24"
    assert json.loads(rows[0]["payload_json"]) == {
        "choice": "approve",
        "decision_ms": 1234,
    }


def test_product_event_payloads_are_bounded(tmp_path):
    store = ChatStore(str(tmp_path / "analytics.sqlite3"), max_bytes=1024 * 1024)
    with pytest.raises(ValueError, match="4096"):
        store.save_product_event(
            event_id="event-1",
            schema_version=1,
            app_version="test",
            event_type="client_error",
            actor_type="browser",
            payload={"value": "x" * 5000},
        )


def test_selfie_metadata_is_indexed_without_storing_image_bytes(tmp_path):
    store = ChatStore(str(tmp_path / "history.sqlite3"), max_bytes=1024 * 1024)
    store.save_selfie_reference(
        room_code="abcd",
        game_started_at=None,
        player_id="player-1",
        player_name="Arthur",
        image_sha256="a" * 64,
        storage_name=f"{'a' * 64}.jpg",
        byte_count=1234,
    )

    row = dict(store.saved_selfies()[0])
    assert row["room_code"] == "ABCD"
    assert row["player_name"] == "Arthur"
    assert row["byte_count"] == 1234
    assert "image" not in row


def test_server_persists_chat_without_exposing_tokens(
    tmp_path, monkeypatch, socket_client, create_game
):
    store = ChatStore(str(tmp_path / "server-chat.sqlite3"))
    store.initialize()
    monkeypatch.setattr(server, "chat_store", store)
    created = create_game(socket_client)
    player = server.socketio.test_client(server.app)
    player.emit(
        "join_game",
        {"room_code": created["room_code"], "player_name": "Arthur"},
    )
    joined = packets_for(player, "join_success")[0]
    game = server.games[created["room_code"]]
    game.phase = server.GamePhase.DISCUSSION
    game.started_at = 100.0
    player.get_received()

    player.emit("send_chat", {"message": "For Camelot"})

    rows = store.messages_for_date(datetime.now(timezone.utc).date())
    assert len(rows) == 1
    assert dict(rows[0]) == {
        "created_at": rows[0]["created_at"],
        "room_code": created["room_code"],
        "game_started_at": 100.0,
        "player_name": "Arthur",
        "message": "For Camelot",
    }
    assert joined["session_token"] not in str(dict(rows[0]))
    chat_payload = packets_for(player, "chat_message")[0]
    assert chat_payload["color_index"] == joined["players"][0]["color_index"]
    player.disconnect()

    replacement = server.socketio.test_client(server.app)
    replacement.emit(
        "reconnect_game", {"session_token": joined["session_token"]}
    )
    snapshot = packets_for(replacement, "state_snapshot")[0]
    assert snapshot["recent_chat"] == [
        {
            "timestamp": rows[0]["created_at"],
            "name": "Arthur",
            "message": "For Camelot",
            "color_index": joined["players"][0]["color_index"],
        }
    ]
    replacement.disconnect()


def test_chat_accepts_long_meme_urls(
    tmp_path, monkeypatch, socket_client, create_game
):
    store = ChatStore(str(tmp_path / "server-chat.sqlite3"))
    store.initialize()
    monkeypatch.setattr(server, "chat_store", store)
    created = create_game(socket_client)
    player = server.socketio.test_client(server.app)
    player.emit("join_game", {"room_code": created["room_code"], "player_name": "Arthur"})
    game = server.games[created["room_code"]]
    game.phase = server.GamePhase.DISCUSSION
    game.started_at = 100.0
    player.get_received()
    url = "https://example.com/memes/" + "a" * 300

    player.emit("send_chat", {"message": url})

    assert packets_for(player, "chat_message")[-1]["message"] == url
    player.disconnect()


def test_player_can_select_avatar_in_lobby(socket_client, create_game):
    created = create_game(socket_client)
    player = server.socketio.test_client(server.app)
    player.emit("join_game", {"room_code": created["room_code"], "player_name": "Arthur"})
    joined = packets_for(player, "join_success")[0]
    player.get_received()

    player.emit("select_avatar", {"avatar_index": 9})

    game = server.games[created["room_code"]]
    assert game.players[joined["player_id"]].avatar_index == 9
    updates = packets_for(player, "lobby_update")
    assert updates[-1]["players"][0]["avatar_index"] == 9
    player.disconnect()


def test_player_can_use_and_privately_archive_a_small_selfie(
    tmp_path, monkeypatch, socket_client, create_game
):
    import base64
    from selfie_archive import SelfieArchive

    store = ChatStore(str(tmp_path / "server-chat.sqlite3"))
    store.initialize()
    monkeypatch.setattr(server, "chat_store", store)
    monkeypatch.setattr(server, "selfie_archive", SelfieArchive(str(tmp_path / "selfies")))

    created = create_game(socket_client)
    player = server.socketio.test_client(server.app)
    player.emit("join_game", {"room_code": created["room_code"], "player_name": "Arthur"})
    joined = packets_for(player, "join_success")[0]
    player.get_received()
    jpeg = b"\xff\xd8" + b"x" * 80 + b"\xff\xd9"
    image = "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()

    player.emit("select_selfie", {"image": image})

    game = server.games[created["room_code"]]
    assert game.players[joined["player_id"]].avatar_image == image
    assert packets_for(player, "lobby_update")[-1]["players"][0]["avatar_image"] == image
    archived = dict(store.saved_selfies()[0])
    assert archived["player_id"] == joined["player_id"]
    saved_file = tmp_path / "selfies" / archived["storage_name"]
    assert saved_file.read_bytes() == jpeg
    assert saved_file.stat().st_mode & 0o777 == 0o600
    assert game.players[joined["player_id"]].selfie_sha256 == archived["image_sha256"]
    player.disconnect()


def test_historical_summary_references_selfie_without_embedding_jpeg():
    game = server.GameState("ABCD")
    player = server.add_player(game, "Arthur", "player-1")
    player.avatar_image = "data:image/jpeg;base64,very-large-image"
    player.selfie_sha256 = "a" * 64

    live = server.get_game_summary(game)
    history = server.historical_game_summary(game)

    assert live["players"][0]["avatar_image"].startswith("data:image")
    assert "avatar_image" not in history["players"][0]
    assert history["players"][0]["selfie_sha256"] == "a" * 64


def test_server_records_bounded_lobby_and_client_analytics(
    tmp_path, monkeypatch, socket_client, create_game
):
    store = ChatStore(str(tmp_path / "server-analytics.sqlite3"))
    store.initialize()
    monkeypatch.setattr(server, "chat_store", store)
    created = create_game(socket_client)
    player = server.socketio.test_client(server.app)
    analytics_id = "11111111-1111-4111-8111-111111111111"
    player.emit(
        "join_game",
        {
            "room_code": created["room_code"],
            "player_name": "Arthur",
            "analytics_id": analytics_id,
        },
    )
    player.emit(
        "client_analytics",
        {
            "analytics_id": analytics_id,
            "event_type": "help_opened",
            "payload": {
                "context": "lobby",
                "not_allowed": "must not persist",
            },
        },
    )
    socket_client.emit("start_game")

    events = store.product_events()
    types = [row["event_type"] for row in events]
    assert "player_joined" in types
    assert "help_opened" in types
    assert "game_start_clicked" in types
    assert "game_start_blocked" in types
    help_event = next(row for row in events if row["event_type"] == "help_opened")
    assert json.loads(help_event["payload_json"]) == {"context": "lobby"}
    assert help_event["analytics_id"] == analytics_id
    assert "must not persist" not in str([dict(row) for row in events])
    player.disconnect()
