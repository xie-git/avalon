import re
import os
import subprocess
import sys

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


def test_game_creation_requires_password_and_returns_separate_capability(socket_client):
    socket_client.emit("create_game", {"admin_password": "wrong"})
    assert packets_for(socket_client, "error")[0]["message"] == "Invalid host password"

    socket_client.emit(
        "create_game", {"admin_password": "correct horse battery staple"}
    )
    result = packets_for(socket_client, "game_created")[0]
    assert re.fullmatch(r"[ABCDEFGHJKMNPQRSTUVWXYZ]{6}", result["room_code"])
    assert len(result["host_token"]) >= 32
    assert result["host_token"] != result["room_code"]


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
    socket_client.emit("create_game", ["not", "an", "object"])
    errors = packets_for(socket_client, "error")
    assert errors == [{"message": "Invalid request"}]


def test_join_attempts_are_rate_limited(socket_client):
    for _ in range(16):
        socket_client.emit(
            "join_game", {"room_code": "ABCDEF", "player_name": "Arthur"}
        )
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


def test_production_configuration_fails_closed_when_secrets_are_missing():
    environment = os.environ.copy()
    environment["APP_ENV"] = "production"
    for name in (
        "SECRET_KEY",
        "HOST_ADMIN_PASSWORD",
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
            "HOST_ADMIN_PASSWORD": "replace-with-a-long-unique-password",
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
