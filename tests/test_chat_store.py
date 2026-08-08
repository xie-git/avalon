from datetime import date, datetime, timezone
import json

import server
from chat_store import ChatStore


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


def test_player_can_select_avatar_in_lobby(socket_client, create_game):
    created = create_game(socket_client)
    player = server.socketio.test_client(server.app)
    player.emit("join_game", {"room_code": created["room_code"], "player_name": "Arthur"})
    joined = packets_for(player, "join_success")[0]
    player.get_received()

    player.emit("select_avatar", {"avatar_index": 6})

    game = server.games[created["room_code"]]
    assert game.players[joined["player_id"]].avatar_index == 6
    updates = packets_for(player, "lobby_update")
    assert updates[-1]["players"][0]["avatar_index"] == 6
    player.disconnect()
