import json
import time

import server
from chat_store import ChatStore
from game_logic import GamePhase, GameState, PlayerInfo, Role, Team, add_player, assign_roles


def packets_for(client, event):
    return [
        packet["args"][0]
        for packet in client.get_received()
        if packet["name"] == event
    ]


def populated_game(code="SAVE"):
    game = GameState(code)
    for index in range(6):
        player = add_player(game, f"Player {index + 1}", f"player-{index + 1:032d}")
        token = f"token-{index + 1}-" + "x" * 32
        player.session_token = token
        player.session_token_hash = server.token_digest(token)
    assign_roles(game)
    game.host_player_id = game.player_order[0]
    game.host_token = "host-" + "y" * 40
    game.host_token_hash = server.token_digest(game.host_token)
    game.phase = GamePhase.TEAM_VOTE
    game.started_at = 1_700_000_000.0
    game.active_elapsed_seconds = 125.0
    game.proposed_team = game.player_order[:2]
    game.votes = {game.player_order[0]: "approve", game.player_order[1]: "reject"}
    game.timer_kind = "proposal"
    game.timer_remaining = 17
    game.suspended = True
    game.inactive_since = time.time()
    game.expires_at = game.inactive_since + 86400
    return game


def test_complex_room_round_trip_preserves_state_without_raw_capabilities():
    game = populated_game()
    state = server.serialize_game(game)
    encoded = json.dumps(state)

    assert game.host_token not in encoded
    assert game.players[game.player_order[0]].session_token not in encoded

    restored = server.deserialize_game(state, saved_at=time.time())
    assert restored.phase == GamePhase.TEAM_VOTE
    assert restored.player_order == game.player_order
    assert restored.proposed_team == game.proposed_team
    assert restored.votes == game.votes
    assert restored.timer_kind == "proposal"
    assert restored.timer_remaining == 17
    assert restored.suspended is True
    assert restored.players[game.player_order[0]].role in Role
    assert restored.players[game.player_order[0]].team in Team
    assert all(not player.connected and player.sid is None for player in restored.players.values())


def test_room_snapshot_survives_runtime_reload(tmp_path, monkeypatch):
    store = ChatStore(str(tmp_path / "rooms.sqlite3"))
    store.initialize()
    monkeypatch.setattr(server, "chat_store", store)
    monkeypatch.setitem(server.app.config, "PERSIST_ROOMS_IN_TESTS", True)
    game = populated_game("LOAD")
    raw_host_token = game.host_token
    server.games[game.code] = game
    for player in game.players.values():
        server.session_tokens[player.session_token_hash] = (game.code, player.player_id)

    server.persist_game(game)
    rows = store.room_snapshots()
    assert len(rows) == 1
    assert rows[0]["room_code"] == "LOAD"

    server.games.clear()
    server.session_tokens.clear()
    server.load_persisted_games()
    restored = server.games["LOAD"]
    assert restored.phase == GamePhase.TEAM_VOTE
    assert restored.votes == game.votes
    assert restored.expires_at is not None
    assert len(server.session_tokens) == 6
    display = server.socketio.test_client(server.app)
    display.emit(
        "register_host_screen",
        {"game_code": "LOAD", "host_token": raw_host_token},
    )
    registered = packets_for(display, "host_registered")[0]
    assert registered["suspended"] is True
    display.disconnect()


def test_full_disconnect_freezes_and_each_resume_renews_expiry(monkeypatch):
    now = [10_000.0]
    monkeypatch.setattr(server.time, "time", lambda: now[0])
    started_tasks = []
    monkeypatch.setattr(
        server.socketio,
        "start_background_task",
        lambda function, *args: started_tasks.append((function, args)),
    )
    game = GameState("TIME")
    player = PlayerInfo("p" * 32, "Arthur")
    player.connected = True
    game.players[player.player_id] = player
    game.player_order = [player.player_id]
    game.phase = GamePhase.DISCUSSION
    game.started_at = 9_900.0
    game.active_since = 9_900.0
    game.timer_kind = "discussion"
    game.timer_deadline = 10_030.0

    player.connected = False
    server.suspend_game(game)
    first_expiry = game.expires_at
    assert game.timer_remaining == 30
    assert game.active_elapsed_seconds == 100
    assert first_expiry == 10_000.0 + server.GAME_TTL_SECONDS

    now[0] = 10_500.0
    player.connected = True
    server.resume_game(game)
    assert game.expires_at is None
    assert game.timer_deadline == 10_530.0
    assert started_tasks[-1][1][2] == 30

    now[0] = 10_510.0
    player.connected = False
    server.suspend_game(game)
    assert game.timer_remaining == 20
    assert game.expires_at == 10_510.0 + server.GAME_TTL_SECONDS
    assert game.expires_at > first_expiry


def test_session_status_does_not_resume_but_reconnect_does():
    token = "z" * 40
    game = GameState("CARD")
    player = PlayerInfo("p" * 32, "Percival")
    player.connected = False
    player.session_token_hash = server.token_digest(token)
    game.players[player.player_id] = player
    game.player_order = [player.player_id]
    game.suspended = True
    game.inactive_since = time.time()
    game.expires_at = game.inactive_since + server.GAME_TTL_SECONDS
    server.games[game.code] = game
    server.session_tokens[player.session_token_hash] = (game.code, player.player_id)
    client = server.socketio.test_client(server.app)

    client.emit("session_status", {"session_token": token})
    status = packets_for(client, "session_status")[0]
    assert status["available"] is True
    assert status["room_code"] == "CARD"
    assert game.suspended is True

    client.emit("reconnect_game", {"session_token": token})
    assert packets_for(client, "state_snapshot")
    assert game.suspended is False
    assert game.expires_at is None
    client.disconnect()


def test_spectator_reconnect_does_not_reactivate_room():
    token = "s" * 40
    game = GameState("SPEC")
    spectator = server.SpectatorInfo("observer-id", "Observer")
    spectator.connected = False
    spectator.session_token_hash = server.token_digest(token)
    game.spectators[spectator.spectator_id] = spectator
    game.suspended = True
    game.inactive_since = time.time()
    game.expires_at = game.inactive_since + server.GAME_TTL_SECONDS
    original_expiry = game.expires_at
    server.games[game.code] = game
    server.spectator_tokens[spectator.session_token_hash] = (
        game.code,
        spectator.spectator_id,
    )
    client = server.socketio.test_client(server.app)
    client.emit("reconnect_game", {"session_token": token})

    snapshot = packets_for(client, "state_snapshot")[0]
    assert snapshot["is_spectator"] is True
    assert game.suspended is True
    assert game.expires_at == original_expiry
    client.disconnect()


def test_expired_room_is_deleted_and_display_pairing_is_one_use(socket_client):
    socket_client.emit("create_player_game", {"player_name": "Arthur"})
    joined = packets_for(socket_client, "join_success")[0]
    game = server.games[joined["room_code"]]

    socket_client.emit("request_display_pairing")
    pairing = packets_for(socket_client, "display_pairing_code")[0]
    display = server.socketio.test_client(server.app)
    display.emit(
        "pair_host_display",
        {"room_code": game.code, "pairing_code": pairing["code"]},
    )
    paired = packets_for(display, "display_paired")[0]
    assert len(paired["host_token"]) >= 32

    replay = server.socketio.test_client(server.app)
    replay.emit(
        "pair_host_display",
        {"room_code": game.code, "pairing_code": pairing["code"]},
    )
    assert "invalid or expired" in packets_for(replay, "display_pairing_failed")[0]["message"]
    replay.disconnect()
    display.disconnect()

    game.suspended = True
    game.expires_at = time.time() - 1
    with server.app.test_request_context():
        server.cleanup_stale_games()
    assert game.code not in server.games
