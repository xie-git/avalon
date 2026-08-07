import re
import os
import subprocess
import sys

import pytest

import server


def packets_for(client, name):
    return [
        packet["args"][0] for packet in client.get_received() if packet["name"] == name
    ]


def test_security_headers_and_development_routes_are_closed():
    client = server.app.test_client()
    response = client.get("/")
    assert response.status_code == 200
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Frame-Options"] == "DENY"
    assert "frame-ancestors 'none'" in response.headers["Content-Security-Policy"]
    assert client.get("/dev").status_code == 404
    assert client.get("/debug/state/ABCDEF").status_code == 404
    assert client.get("/healthz").json == {"status": "ok"}
    assert b'maxlength="4"' in response.data
    host_response = client.get("/host")
    assert b"host-admin-password" not in host_response.data
    assert b"Create Game" in host_response.data


def test_party_pages_do_not_reference_image_or_audio_assets():
    client = server.app.test_client()
    served_files = (
        client.get("/").data,
        client.get("/host").data,
        client.get("/static/js/player.js").data,
        client.get("/static/js/host.js").data,
        client.get("/static/css/common.css").data,
        client.get("/static/css/player.css").data,
    )
    combined = b"\n".join(served_files).lower()
    for marker in (b"<img", b"new audio", b"/static/img", b"/static/sounds"):
        assert marker not in combined


def test_game_creation_is_one_click_and_returns_separate_capability(socket_client):
    socket_client.emit("create_game")
    result = packets_for(socket_client, "game_created")[0]
    assert re.fullmatch(r"[ABCDEFGHJKMNPQRSTUVWXYZ]{4}", result["room_code"])
    assert len(result["host_token"]) >= 32
    assert result["host_token"] != result["room_code"]


def test_repeated_create_from_same_host_is_idempotent(socket_client):
    socket_client.emit("create_game")
    first = packets_for(socket_client, "game_created")[0]
    socket_client.emit("create_game")
    second = packets_for(socket_client, "game_created")[0]
    assert second["room_code"] == first["room_code"]
    assert len(server.games) == 1


def test_host_reconnect_rejects_room_code_without_capability(
    socket_client, create_game
):
    created = create_game(socket_client)
    attacker = server.socketio.test_client(server.app)
    attacker.emit(
        "register_host_screen",
        {
            "game_code": created["room_code"],
            "host_token": "x" * 32,
        },
    )
    assert "authorization invalid" in packets_for(attacker, "error")[0]["message"]

    legitimate = server.socketio.test_client(server.app)
    legitimate.emit(
        "register_host_screen",
        {
            "game_code": created["room_code"],
            "host_token": created["host_token"],
        },
    )
    assert packets_for(legitimate, "host_registered")[0]["code"] == created["room_code"]
    attacker.disconnect()
    legitimate.disconnect()


def test_player_never_receives_host_authority(socket_client, create_game):
    created = create_game(socket_client)
    player = server.socketio.test_client(server.app)
    player.emit(
        "join_game", {"room_code": created["room_code"], "player_name": "Arthur"}
    )
    joined = packets_for(player, "join_success")[0]
    assert joined["is_host"] is False
    player.emit("end_game")
    assert packets_for(player, "error")[0]["message"] == "Host authorization required"
    assert created["room_code"] in server.games
    player.disconnect()


def test_malformed_payload_is_controlled(socket_client):
    socket_client.emit("join_game", ["not", "an", "object"])
    errors = packets_for(socket_client, "error")
    assert errors == [{"message": "Invalid request"}]


def test_join_attempts_are_rate_limited(socket_client):
    for _ in range(16):
        socket_client.emit("join_game", {"room_code": "ABCD", "player_name": "Arthur"})
    messages = [packet["message"] for packet in packets_for(socket_client, "error")]
    assert "Too many requests. Please wait and try again." in messages


def test_only_host_can_advance_completed_mission(socket_client, create_game):
    created = create_game(socket_client)
    player = server.socketio.test_client(server.app)
    player.emit(
        "join_game", {"room_code": created["room_code"], "player_name": "Arthur"}
    )
    player.get_received()
    server.games[created["room_code"]].pending_mission_outcome = "next_mission"
    player.emit("advance_after_mission")
    assert packets_for(player, "error")[0]["message"] == "Host authorization required"
    assert server.games[created["room_code"]].pending_mission_outcome == "next_mission"
    player.disconnect()


def test_roles_are_delivered_only_to_each_player(socket_client, create_game):
    created = create_game(socket_client)
    players = []
    for index in range(6):
        player = server.socketio.test_client(server.app)
        player.emit(
            "join_game",
            {
                "room_code": created["room_code"],
                "player_name": f"Player {index}",
            },
        )
        player.get_received()
        players.append(player)
    socket_client.get_received()
    socket_client.emit("start_game")
    host_packets = socket_client.get_received()
    assert not [packet for packet in host_packets if packet["name"] == "role_assigned"]
    for player in players:
        roles = packets_for(player, "role_assigned")
        assert len(roles) == 1
        assert set(roles[0]) == {"role", "team", "night_info"}
        player.disconnect()


def test_host_can_reorder_players_with_browser_payload(socket_client, create_game):
    created = create_game(socket_client)
    players = []
    for name in ("Arthur", "Merlin"):
        player = server.socketio.test_client(server.app)
        player.emit(
            "join_game", {"room_code": created["room_code"], "player_name": name}
        )
        player.get_received()
        players.append(player)
    socket_client.get_received()
    socket_client.emit("reorder_players", {"order": ["Merlin", "Arthur"]})
    updates = packets_for(socket_client, "lobby_update")
    assert [player["name"] for player in updates[-1]["players"]] == ["Merlin", "Arthur"]
    for player in players:
        player.disconnect()


def test_beta_mode_is_host_only_and_fills_then_removes_bots(
    socket_client, create_game
):
    created = create_game(socket_client)
    player = server.socketio.test_client(server.app)
    player.emit(
        "join_game", {"room_code": created["room_code"], "player_name": "Arthur"}
    )
    player.get_received()

    player.emit("set_beta_test_mode", {"enabled": True})
    assert packets_for(player, "error")[0]["message"] == "Host authorization required"

    socket_client.emit("set_beta_test_mode", {"enabled": True})
    game = server.games[created["room_code"]]
    assert game.beta_test_mode is True
    assert game.player_count() == 6
    assert sum(p.is_bot for p in game.players.values()) == 5
    assert all("is_bot" in p for p in game.public_players())

    socket_client.emit("set_beta_test_mode", {"enabled": False})
    assert game.beta_test_mode is False
    assert game.player_count() == 1
    assert not any(p.is_bot for p in game.players.values())
    player.disconnect()


def test_one_human_can_start_beta_game_and_bots_confirm_night(
    socket_client, create_game
):
    created = create_game(socket_client)
    player = server.socketio.test_client(server.app)
    player.emit(
        "join_game", {"room_code": created["room_code"], "player_name": "Arthur"}
    )
    player.get_received()
    socket_client.get_received()

    socket_client.emit("set_beta_test_mode", {"enabled": True})
    socket_client.emit("start_game")
    game = server.games[created["room_code"]]
    assert game.phase == server.GamePhase.NIGHT_PHASE
    assert len(game.night_acks) == 5

    player.emit("night_phase_ack")
    assert game.phase == server.GamePhase.DISCUSSION
    player.disconnect()


@pytest.mark.parametrize("beta_count", range(6, 11))
def test_one_human_and_random_bots_can_finish_a_complete_game(
    socket_client, create_game, beta_count
):
    created = create_game(socket_client)
    player = server.socketio.test_client(server.app)
    player.emit(
        "join_game", {"room_code": created["room_code"], "player_name": "Arthur"}
    )
    joined = packets_for(player, "join_success")[0]
    human_id = joined["player_id"]
    socket_client.get_received()
    socket_client.emit(
        "set_beta_test_mode", {"enabled": True, "target_count": beta_count}
    )
    assert server.games[created["room_code"]].player_count() == beta_count
    socket_client.emit("start_game")
    player.get_received()
    player.emit("night_phase_ack")
    game = server.games[created["room_code"]]

    for _ in range(100):
        if game.phase == server.GamePhase.GAME_OVER:
            break
        if game.phase == server.GamePhase.DISCUSSION:
            socket_client.emit("skip_discussion", {"confirmed": True})
        elif game.phase == server.GamePhase.TEAM_PROPOSAL:
            assert game.current_leader().player_id == human_id
            player.emit(
                "propose_team",
                {"team": game.player_order[: game.mission_size()]},
            )
        elif game.phase == server.GamePhase.TEAM_VOTE:
            player.emit("cast_vote", {"vote": "approve"})
        elif game.phase == server.GamePhase.MISSION:
            assert human_id in game.proposed_team
            player.emit("play_mission_card", {"card": "success"})
        elif game.phase == server.GamePhase.MISSION_REVEAL:
            socket_client.emit("advance_after_mission")
        elif game.phase == server.GamePhase.ASSASSIN_PHASE:
            assert server.get_assassin(game).player_id == human_id
            player.emit(
                "assassinate",
                {
                    "target_player_id": server.get_assassin_targets(game)[
                        0
                    ].player_id
                },
            )
        else:
            pytest.fail(f"Beta game stalled in {game.phase}")

    assert game.phase == server.GamePhase.GAME_OVER
    assert game.winner in {"good", "evil"}
    player.disconnect()


def test_production_configuration_fails_closed_when_secrets_are_missing():
    environment = os.environ.copy()
    environment["APP_ENV"] = "production"
    for name in (
        "SECRET_KEY",
        "PUBLIC_BASE_URL",
        "PUBLIC_ORIGIN",
    ):
        environment.pop(name, None)
    result = subprocess.run(
        [sys.executable, "-c", "import server"],
        cwd=os.path.dirname(server.__file__),
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode != 0
    assert "Missing required production settings" in result.stderr


def test_production_configuration_rejects_example_secrets():
    environment = os.environ.copy()
    environment.update(
        {
            "APP_ENV": "production",
            "SECRET_KEY": "replace-with-output-of-python-secrets-command",
            "PUBLIC_BASE_URL": "https://avalon.example.ts.net",
            "PUBLIC_ORIGIN": "https://avalon.example.ts.net",
        }
    )
    result = subprocess.run(
        [sys.executable, "-c", "import server"],
        cwd=os.path.dirname(server.__file__),
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode != 0
    assert "Replace the example production secrets" in result.stderr


def test_multiple_games_are_isolated(create_game):
    host_one = server.socketio.test_client(server.app)
    host_two = server.socketio.test_client(server.app)
    first = create_game(host_one)
    second = create_game(host_two)
    assert first["room_code"] != second["room_code"]

    host_one.get_received()
    host_two.get_received()
    player = server.socketio.test_client(server.app)
    player.emit("join_game", {"room_code": first["room_code"], "player_name": "Arthur"})
    assert len(packets_for(host_one, "player_joined")) == 1
    assert packets_for(host_two, "player_joined") == []

    player.disconnect()
    host_one.disconnect()
    host_two.disconnect()


def test_stale_games_are_reclaimed_when_a_new_game_is_created(
    socket_client, create_game
):
    stale = create_game(socket_client)
    stale_code = stale["room_code"]
    server.game_activity[stale_code] = (
        server.time.monotonic() - server.GAME_TTL_SECONDS - 1
    )
    socket_client.emit("create_game")
    new_game = packets_for(socket_client, "game_created")[0]
    assert stale_code not in server.games
    assert new_game["room_code"] in server.games


def join_players(host, create_game, count=6):
    created = create_game(host)
    clients = []
    joined = []
    for index in range(count):
        client = server.socketio.test_client(server.app)
        client.emit(
            "join_game",
            {
                "room_code": created["room_code"],
                "player_name": f"Player {index}",
            },
        )
        joined.append(packets_for(client, "join_success")[0])
        clients.append(client)
    host.get_received()
    return created, clients, joined


def test_complete_mission_waits_for_host_before_advancing(socket_client, create_game):
    created, clients, _ = join_players(socket_client, create_game)
    game = server.games[created["room_code"]]

    socket_client.emit("start_game")
    for client in clients:
        client.get_received()
        client.emit("night_phase_ack")
    assert game.phase == server.GamePhase.DISCUSSION

    socket_client.emit("skip_discussion", {"confirmed": True})
    leader_id = game.current_leader().player_id
    leader_index = game.player_order.index(leader_id)
    team = game.player_order[: game.mission_size()]
    clients[leader_index].emit("propose_team", {"team": team})
    assert game.votes == {}
    for client in clients:
        client.emit("cast_vote", {"vote": "approve"})
    assert game.phase == server.GamePhase.MISSION

    for player_id in team:
        client = clients[game.player_order.index(player_id)]
        client.emit("play_mission_card", {"card": "success"})
    assert game.phase == server.GamePhase.MISSION_REVEAL
    assert game.pending_mission_outcome == "next_mission"
    assert game.current_mission == 0

    socket_client.emit("advance_after_mission")
    assert game.phase == server.GamePhase.DISCUSSION
    assert game.current_mission == 1
    for client in clients:
        client.disconnect()


def test_return_to_lobby_keeps_party_and_reconnect_tokens(socket_client, create_game):
    created, clients, joined = join_players(socket_client, create_game)
    game = server.games[created["room_code"]]
    original_ids = list(game.player_order)

    socket_client.emit("start_game")
    socket_client.emit("return_to_lobby")

    assert game.phase == server.GamePhase.LOBBY
    assert game.player_order == original_ids
    assert all(player.role is None for player in game.players.values())
    lobby = packets_for(clients[0], "return_to_lobby")[-1]
    assert len(lobby["players"]) == 6

    clients[0].disconnect()
    reconnected = server.socketio.test_client(server.app)
    reconnected.emit(
        "reconnect_game", {"session_token": joined[0]["session_token"]}
    )
    snapshot = packets_for(reconnected, "state_snapshot")[0]
    assert snapshot["phase"] == server.GamePhase.LOBBY
    assert snapshot["my_player_id"] == original_ids[0]
    assert len(snapshot["players"]) == 6
    reconnected.disconnect()
    for client in clients[1:]:
        client.disconnect()


def test_reconnect_snapshot_restores_actionable_vote_state(socket_client, create_game):
    created, clients, joined = join_players(socket_client, create_game)
    game = server.games[created["room_code"]]
    socket_client.emit("start_game")
    for client in clients:
        client.get_received()
        client.emit("night_phase_ack")
    socket_client.emit("skip_discussion", {"confirmed": True})

    leader_id = game.current_leader().player_id
    leader_index = game.player_order.index(leader_id)
    team = game.player_order[: game.mission_size()]
    clients[leader_index].emit("propose_team", {"team": team})
    reconnect_index = next(i for i, pid in enumerate(game.player_order) if pid != leader_id)
    clients[reconnect_index].disconnect()

    reconnected = server.socketio.test_client(server.app)
    reconnected.emit(
        "reconnect_game",
        {"session_token": joined[reconnect_index]["session_token"]},
    )
    snapshot = packets_for(reconnected, "state_snapshot")[0]
    assert snapshot["phase"] == server.GamePhase.TEAM_VOTE
    assert snapshot["proposed_team_ids"] == team
    assert snapshot["team"] == [game.players[pid].name for pid in team]
    assert snapshot["player_name_to_id"] == {
        game.players[pid].name: pid for pid in game.player_order
    }
    reconnected.disconnect()
    for index, client in enumerate(clients):
        if index != reconnect_index:
            client.disconnect()


@pytest.mark.parametrize("player_count", range(6, 11))
def test_every_supported_party_size_reaches_first_mission(
    socket_client, create_game, player_count
):
    created, clients, _ = join_players(socket_client, create_game, player_count)
    game = server.games[created["room_code"]]

    socket_client.emit("start_game")
    assert game.player_count() == player_count
    for client in clients:
        client.get_received()
        client.emit("night_phase_ack")
    assert game.phase == server.GamePhase.DISCUSSION

    socket_client.emit("skip_discussion", {"confirmed": True})
    leader_index = game.player_order.index(game.current_leader().player_id)
    team = game.player_order[: game.mission_size()]
    clients[leader_index].emit("propose_team", {"team": team})
    assert game.votes == {}
    for client in clients:
        client.emit("cast_vote", {"vote": "approve"})
    assert game.phase == server.GamePhase.MISSION
    assert len(game.proposed_team) == server.MISSION_SIZES[player_count][0]

    for client in clients:
        client.disconnect()
