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
    assert b"Pair this screen" in host_response.data
    assert b"Display only" in host_response.data
    assert b'id="btn-start-game"' not in host_response.data
    assert b'id="btn-host-settings"' not in host_response.data
    assert b'id="discussion-slider"' not in host_response.data
    assert b"Host a Game" in response.data
    assert b"Pair a Shared Display" in response.data

    presence_script = client.get("/static/js/presence.js").data
    assert presence_script.index(b'data-view="order"') < presence_script.index(b'data-view="private"')
    assert b">Reset</button>" in presence_script


def test_party_pages_do_not_reference_portrait_or_audio_assets():
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
    for marker in (b"new audio", b"/static/img", b"/static/sounds"):
        assert marker not in combined


def test_chat_links_are_http_only_and_open_safely():
    client = server.app.test_client()
    player_js = client.get("/static/js/player.js").data
    host_js = client.get("/static/js/host.js").data

    for script in (player_js, host_js):
        assert b"parsed.protocol === 'http:'" in script
        assert b"parsed.protocol === 'https:'" in script
        assert b"link.target = '_blank'" in script
        assert b"link.rel = 'noopener noreferrer'" in script


def test_join_qr_is_same_origin_and_only_exists_for_live_rooms(socket_client, create_game):
    created = create_game(socket_client)
    client = server.app.test_client()

    response = client.get(f"/join-qr.svg?room={created['room_code']}")
    assert response.status_code == 200
    assert response.mimetype == "image/svg+xml"
    assert b"<svg" in response.data
    assert response.headers["Cache-Control"] == "no-store"
    assert client.get("/join-qr.svg?room=ZZZZ").status_code == 404


def test_game_creation_is_one_click_and_returns_separate_capability(socket_client):
    socket_client.emit("create_game")
    result = packets_for(socket_client, "game_created")[0]
    assert re.fullmatch(r"[ABCDEFGHJKMNPQRSTUVWXYZ]{4}", result["room_code"])
    assert len(result["host_token"]) >= 32
    assert result["host_token"] != result["room_code"]


def test_phone_creator_hosts_while_occupying_a_player_seat(socket_client):
    socket_client.emit("create_player_game", {"player_name": "Arthur"})
    joined = packets_for(socket_client, "join_success")[0]
    game = server.games[joined["room_code"]]

    assert joined["is_host"] is True
    assert joined["player_id"] == game.host_player_id
    assert game.player_count() == 1


def test_player_can_rename_only_in_lobby(socket_client):
    socket_client.emit("create_player_game", {"player_name": "Arthur"})
    joined = packets_for(socket_client, "join_success")[0]
    game = server.games[joined["room_code"]]

    socket_client.emit("change_name", {"player_name": "Artoria"})

    assert game.players[joined["player_id"]].name == "Artoria"
    packets = socket_client.get_received()
    changed = [packet["args"][0] for packet in packets if packet["name"] == "name_changed"]
    updates = [packet["args"][0] for packet in packets if packet["name"] == "lobby_update"]
    assert changed[-1] == {
        "player_name": "Artoria"
    }
    assert updates[-1]["players"][0]["name"] == "Artoria"

    game.phase = server.GamePhase.DISCUSSION
    socket_client.emit("change_name", {"player_name": "Merlin"})

    assert game.players[joined["player_id"]].name == "Artoria"
    assert "Wrong game phase" in packets_for(socket_client, "name_change_failed")[-1]["message"]


def test_player_rename_rejects_duplicate_name(socket_client):
    socket_client.emit("create_player_game", {"player_name": "Arthur"})
    joined = packets_for(socket_client, "join_success")[0]
    second = server.socketio.test_client(server.app)
    second.emit("join_game", {"room_code": joined["room_code"], "player_name": "Merlin"})
    second.get_received()

    socket_client.emit("change_name", {"player_name": "merlin"})

    assert server.games[joined["room_code"]].players[joined["player_id"]].name == "Arthur"
    assert "already taken" in packets_for(socket_client, "name_change_failed")[-1]["message"]
    second.disconnect()


def test_only_host_can_manage_practice_bots(socket_client):
    socket_client.emit("create_player_game", {"player_name": "Arthur"})
    joined = packets_for(socket_client, "join_success")[0]
    game = server.games[joined["room_code"]]

    player = server.socketio.test_client(server.app)
    player.emit("join_game", {"room_code": joined["room_code"], "player_name": "Merlin"})
    player.get_received()
    player.emit("set_beta_test_mode", {"enabled": True, "target_count": 8})
    assert game.player_count() == 2
    assert "Host authorization required" in packets_for(player, "error")[-1]["message"]

    socket_client.emit("set_beta_test_mode", {"enabled": True, "target_count": 8})
    update = packets_for(socket_client, "lobby_update")[-1]
    assert game.player_count() == 8
    assert sum(candidate.is_bot for candidate in game.players.values()) == 6
    assert update["settings"]["beta_test_mode"] is True
    assert update["settings"]["beta_test_player_count"] == 8
    assert all(candidate.ready for candidate in game.players.values() if candidate.is_bot)
    player.disconnect()


def test_paired_shared_display_is_read_only(socket_client):
    socket_client.emit("create_player_game", {"player_name": "Arthur"})
    joined = packets_for(socket_client, "join_success")[0]
    game = server.games[joined["room_code"]]
    original_order = list(game.player_order)

    socket_client.emit("request_display_pairing")
    pairing = packets_for(socket_client, "display_pairing_code")[0]
    display = server.socketio.test_client(server.app)
    display.emit(
        "pair_host_display",
        {"room_code": game.code, "pairing_code": pairing["code"]},
    )
    assert packets_for(display, "display_paired")

    attempts = (
        ("update_settings", {"discussion_time": 300}),
        ("reorder_players", {"order": ["Arthur"]}),
        ("start_game", None),
        ("return_to_lobby", None),
        ("end_game", None),
    )
    for event, payload in attempts:
        if payload is None:
            display.emit(event)
        else:
            display.emit(event, payload)
        assert "Host authorization required" in packets_for(display, "error")[-1]["message"]

    assert game.code in server.games
    assert game.phase == server.GamePhase.LOBBY
    assert game.discussion_time == 60
    assert game.player_order == original_order
    display.disconnect()


def test_bot_leader_automatically_reaches_team_vote(socket_client):
    socket_client.emit("create_player_game", {"player_name": "Arthur"})
    joined = packets_for(socket_client, "join_success")[0]
    socket_client.emit("set_beta_test_mode", {"enabled": True, "target_count": 6})
    socket_client.emit("start_game")
    game = server.games[joined["room_code"]]
    game.current_leader_index = next(
        index
        for index, player_id in enumerate(game.player_order)
        if game.players[player_id].is_bot
    )
    socket_client.get_received()

    socket_client.emit("night_phase_ack")

    event_names = [packet["name"] for packet in socket_client.get_received()]
    assert "discussion_start" in event_names
    assert "proposal_start" in event_names
    assert "vote_start" in event_names
    assert game.phase == server.GamePhase.TEAM_VOTE
    assert game.proposed_team


def test_discussion_setting_accepts_one_to_fifteen_minutes_and_unlimited(socket_client):
    socket_client.emit("create_player_game", {"player_name": "Arthur"})
    joined = packets_for(socket_client, "join_success")[0]
    game = server.games[joined["room_code"]]

    for seconds in (60, 900, 0):
        socket_client.emit("update_settings", {"discussion_time": seconds})
        assert game.discussion_time == seconds
        update = packets_for(socket_client, "lobby_update")[-1]
        assert update["settings"]["discussion_time"] == seconds

    socket_client.emit("update_settings", {"discussion_time": 59})
    assert packets_for(socket_client, "error")[-1]["message"] == (
        "discussion_time must be Unlimited or at least 60 seconds"
    )
    assert game.discussion_time == 0


def test_leader_can_spotlight_a_player_without_changing_gameplay(socket_client):
    socket_client.emit("create_player_game", {"player_name": "Arthur"})
    joined = packets_for(socket_client, "join_success")[0]
    second = server.socketio.test_client(server.app)
    second.emit(
        "join_game",
        {"room_code": joined["room_code"], "player_name": "Guinevere"},
    )
    game = server.games[joined["room_code"]]
    game.phase = server.GamePhase.DISCUSSION
    game.current_leader_index = game.player_order.index(joined["player_id"])
    target_id = next(player_id for player_id in game.player_order if player_id != joined["player_id"])
    target_name = game.players[target_id].name

    socket_client.emit("set_discussion_spotlight", {"player_id": target_id})

    assert game.spotlight_player_id == target_id
    spotlight = packets_for(socket_client, "discussion_spotlight")[-1]
    assert spotlight == {
        "player_id": target_id,
        "player_name": target_name,
        "leader_name": "Arthur",
    }
    assert game.phase == server.GamePhase.DISCUSSION
    assert game.proposed_team == []
    second.disconnect()


def test_all_players_can_run_it_back(socket_client):
    socket_client.emit("create_player_game", {"player_name": "Arthur"})
    joined = packets_for(socket_client, "join_success")[0]
    second = server.socketio.test_client(server.app)
    second.emit(
        "join_game",
        {"room_code": joined["room_code"], "player_name": "Guinevere"},
    )
    second_joined = packets_for(second, "join_success")[0]
    game = server.games[joined["room_code"]]
    game.phase = server.GamePhase.GAME_OVER
    game.winner = "good"
    game.win_reason = "missions"
    socket_client.get_received()
    second.get_received()

    socket_client.emit("set_rematch_ready", {"ready": True})
    status = packets_for(socket_client, "rematch_status")[-1]
    assert status["ready_count"] == 1
    assert status["total_count"] == 2
    assert game.phase == server.GamePhase.GAME_OVER

    second.emit("set_rematch_ready", {"ready": True})

    assert game.phase == server.GamePhase.LOBBY
    assert game.rematch_ready == set()
    lobby = packets_for(second, "return_to_lobby")[-1]
    assert len(lobby["players"]) == 2
    assert all(player.role is None for player in game.players.values())
    assert second_joined["player_id"] in game.players
    second.disconnect()


def test_phone_only_game_reaches_first_mission_without_host_display(socket_client):
    socket_client.emit("create_player_game", {"player_name": "Arthur"})
    created = packets_for(socket_client, "join_success")[0]
    clients = [socket_client]
    for index in range(1, 6):
        client = server.socketio.test_client(server.app)
        client.emit(
            "join_game",
            {"room_code": created["room_code"], "player_name": f"Player {index}"},
        )
        client.get_received()
        clients.append(client)

    socket_client.emit("start_game")
    game = server.games[created["room_code"]]
    for client in clients:
        client.get_received()
        client.emit("night_phase_ack")

    leader_index = game.player_order.index(game.current_leader().player_id)
    clients[leader_index].emit("skip_discussion", {"confirmed": True})
    team = game.player_order[: game.mission_size()]
    clients[leader_index].emit("propose_team", {"team": team})
    for client in clients:
        client.emit("cast_vote", {"vote": "approve"})
    reveal = packets_for(clients[leader_index], "vote_reveal")[-1]
    assert reveal["team"] == [game.players[player_id].name for player_id in team]
    clients[leader_index].emit("confirm_vote_reveal")

    assert game.phase == server.GamePhase.MISSION
    for player_id in team:
        clients[game.player_order.index(player_id)].emit(
            "play_mission_card", {"card": "success"}
        )
    clients[leader_index].emit("advance_after_mission")

    assert game.current_mission == 1
    assert game.phase == server.GamePhase.DISCUSSION
    for client in clients[1:]:
        client.disconnect()


def test_group_spectrum_averages_other_players_and_ignores_self_rating(
    socket_client, create_game
):
    created = create_game(socket_client)
    arthur = server.socketio.test_client(server.app)
    arthur.emit(
        "join_game", {"room_code": created["room_code"], "player_name": "Arthur"}
    )
    arthur_join = packets_for(arthur, "join_success")[0]
    merlin = server.socketio.test_client(server.app)
    merlin.emit(
        "join_game", {"room_code": created["room_code"], "player_name": "Merlin"}
    )
    merlin_join = packets_for(merlin, "join_success")[0]
    percival = server.socketio.test_client(server.app)
    percival.emit(
        "join_game", {"room_code": created["room_code"], "player_name": "Percival"}
    )
    percival_join = packets_for(percival, "join_success")[0]
    socket_client.get_received()

    arthur.emit(
        "update_spectrum_ratings",
        {"positions": {
            arthur_join["player_id"]: {"x": 1.0, "y": 1.0},
            percival_join["player_id"]: {"x": 0.8, "y": 0.2},
        }},
    )
    merlin.emit(
        "update_spectrum_ratings",
        {"positions": {
            percival_join["player_id"]: {"x": 0.4, "y": 0.6},
        }},
    )
    percival.emit(
        "update_spectrum_ratings",
        {"positions": {
            arthur_join["player_id"]: {"x": 0.2, "y": 0.7},
            percival_join["player_id"]: {"x": 0.0, "y": 0.0},
        }},
    )

    positions = packets_for(socket_client, "public_spectrum_updated")[-1]["positions"]
    assert positions[percival_join["player_id"]] == {"x": 0.6, "y": 0.4}
    assert positions[arthur_join["player_id"]] == {"x": 0.2, "y": 0.7}

    newcomer = server.socketio.test_client(server.app)
    newcomer.emit(
        "join_game", {"room_code": created["room_code"], "player_name": "Gawain"}
    )
    newcomer_join = packets_for(newcomer, "join_success")[0]
    assert newcomer_join["public_spectrum"] == positions
    newcomer.disconnect()
    percival.disconnect()
    merlin.disconnect()
    arthur.disconnect()


def test_group_spectrum_rejects_invalid_or_unauthorized_updates(socket_client, create_game):
    created = create_game(socket_client)
    player = server.socketio.test_client(server.app)
    player.emit(
        "join_game", {"room_code": created["room_code"], "player_name": "Arthur"}
    )
    joined = packets_for(player, "join_success")[0]
    socket_client.get_received()

    player.emit(
        "update_spectrum_ratings",
        {"positions": {joined["player_id"]: {"x": 1.2, "y": 0.5}}},
    )
    assert packets_for(player, "error")[-1]["message"] == (
        "Spectrum coordinates must be between 0 and 1"
    )

    outsider = server.socketio.test_client(server.app)
    outsider.emit(
        "update_spectrum_ratings",
        {"positions": {joined["player_id"]: {"x": 0.5, "y": 0.5}}},
    )
    assert packets_for(outsider, "error")[-1]["message"] == "Not connected to a game"
    assert server.games[created["room_code"]].spectrum_ratings == {}
    outsider.disconnect()
    player.disconnect()


def test_spectator_can_watch_chat_and_reconnect_without_taking_a_seat(
    socket_client, create_game
):
    created = create_game(socket_client)
    spectator = server.socketio.test_client(server.app)
    spectator.emit(
        "join_spectator",
        {"room_code": created["room_code"], "spectator_name": "Observer"},
    )
    joined = packets_for(spectator, "spectator_join_success")[0]
    game = server.games[created["room_code"]]

    assert game.player_count() == 0
    assert len(game.spectators) == 1
    assert joined["snapshot"]["is_spectator"] is True
    assert "my_role" not in joined["snapshot"]

    token = joined["session_token"]
    spectator.disconnect()
    replacement = server.socketio.test_client(server.app)
    replacement.emit("reconnect_game", {"session_token": token})
    restored = packets_for(replacement, "state_snapshot")[0]
    assert restored["is_spectator"] is True
    assert restored["my_name"] == "Observer"
    replacement.disconnect()


def test_spectator_chat_is_labeled_and_game_inputs_are_rejected(
    socket_client, create_game
):
    created = create_game(socket_client)
    spectator = server.socketio.test_client(server.app)
    spectator.emit(
        "join_spectator",
        {"room_code": created["room_code"], "spectator_name": "Observer"},
    )
    packets_for(spectator, "spectator_join_success")
    game = server.games[created["room_code"]]
    game.phase = server.GamePhase.DISCUSSION
    game.started_at = 1.0

    spectator.emit("send_chat", {"message": "Hail!"})
    message = packets_for(socket_client, "chat_message")[-1]
    assert message["name"] == "Observer"
    assert message["is_spectator"] is True

    spectator.emit("update_spectrum_ratings", {"positions": {}})
    assert packets_for(spectator, "error")[-1]["message"] == "Not a player"
    assert game.spectrum_ratings == {}

    game.phase = server.GamePhase.TEAM_VOTE
    spectator.emit("cast_vote", {"vote": "approve"})
    assert packets_for(spectator, "error")[-1]["message"] == "Not a player"
    assert game.votes == {}
    spectator.disconnect()


def test_spectator_vision_modes_keep_roles_private_and_update_connected_count(
    socket_client, create_game
):
    created, clients, _ = join_players(socket_client, create_game)
    socket_client.get_received()
    omniscient = server.socketio.test_client(server.app)
    omniscient.emit(
        "join_spectator",
        {
            "room_code": created["room_code"],
            "spectator_name": "Seer",
            "vision_mode": "omniscient",
        },
    )
    joined = packets_for(omniscient, "spectator_join_success")[0]
    assert joined["snapshot"]["spectator_vision_mode"] == "omniscient"
    assert joined["snapshot"]["spectator_roles"] == []
    assert packets_for(socket_client, "spectator_count_updated")[-1] == {
        "spectator_count": 1
    }

    socket_client.emit("start_game")
    revealed = packets_for(omniscient, "spectator_roles_revealed")[-1]["players"]
    assert len(revealed) == 6
    assert all(set(player) == {"player_id", "name", "role", "team"} for player in revealed)

    blind = server.socketio.test_client(server.app)
    blind.emit(
        "join_spectator",
        {
            "room_code": created["room_code"],
            "spectator_name": "Watcher",
            "vision_mode": "blind",
        },
    )
    blind_snapshot = packets_for(blind, "spectator_join_success")[0]["snapshot"]
    assert blind_snapshot["spectator_vision_mode"] == "blind"
    assert "spectator_roles" not in blind_snapshot
    assert "spectator_roles_revealed" not in [
        packet["name"] for packet in blind.get_received()
    ]

    omniscient.disconnect()
    assert packets_for(socket_client, "spectator_count_updated")[-1] == {
        "spectator_count": 1
    }
    blind.disconnect()
    for client in clients:
        client.disconnect()


def test_host_display_owner_can_also_join_as_a_player(socket_client, create_game):
    created = create_game(socket_client)
    player_view = server.socketio.test_client(server.app)
    player_view.emit(
        "join_game",
        {"room_code": created["room_code"], "player_name": "Host Player"},
    )

    joined = packets_for(player_view, "join_success")[0]
    game = server.games[created["room_code"]]
    assert joined["player_name"] == "Host Player"
    assert game.host_sid in server.sid_to_info
    assert game.player_count() == 1
    player_view.disconnect()


def test_repeated_create_from_same_host_is_idempotent(socket_client):
    socket_client.emit("create_game")
    first = packets_for(socket_client, "game_created")[0]
    socket_client.emit("create_game")
    second = packets_for(socket_client, "game_created")[0]
    assert second["room_code"] == first["room_code"]
    assert len(server.games) == 1


def test_repeated_join_from_same_socket_is_idempotent(socket_client, create_game):
    created = create_game(socket_client)
    player = server.socketio.test_client(server.app)
    payload = {"room_code": created["room_code"], "player_name": "Arthur"}
    player.emit("join_game", payload)
    first = packets_for(player, "join_success")[0]
    player.emit("join_game", payload)
    second = packets_for(player, "join_success")[0]

    assert second["player_id"] == first["player_id"]
    assert second["session_token"] == first["session_token"]
    assert server.games[created["room_code"]].player_count() == 1
    player.disconnect()


def test_socket_cannot_switch_to_another_game(socket_client, create_game):
    first = create_game(socket_client)
    other_host = server.socketio.test_client(server.app)
    second = create_game(other_host)

    socket_client.emit(
        "join_game", {"room_code": second["room_code"], "player_name": "Arthur"}
    )
    assert packets_for(socket_client, "error")[-1]["message"] == (
        "This connection is already in another game"
    )
    original_host_sid = server.games[first["room_code"]].host_sid
    assert original_host_sid in server.sid_to_info
    assert server.sid_to_info[original_host_sid]["game_code"] == first["room_code"]
    assert server.games[second["room_code"]].player_count() == 0
    other_host.disconnect()


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


def test_invalid_player_reconnect_has_a_recoverable_client_event():
    client = server.socketio.test_client(server.app)
    client.emit("reconnect_game", {"session_token": "x" * 32})

    assert packets_for(client, "reconnect_failed") == [
        {"message": "Session not found. Please rejoin."}
    ]
    client.disconnect()


def test_host_reconnect_snapshot_includes_night_confirmation_progress(
    socket_client, create_game
):
    created, clients, _ = join_players(socket_client, create_game)
    socket_client.emit("start_game")
    clients[0].emit("night_phase_ack")

    replacement = server.socketio.test_client(server.app)
    replacement.emit(
        "register_host_screen",
        {
            "game_code": created["room_code"],
            "host_token": created["host_token"],
        },
    )
    snapshot = packets_for(replacement, "host_registered")[0]
    assert snapshot["phase"] == server.GamePhase.NIGHT_PHASE
    assert snapshot["night_confirmed"] == 1
    assert snapshot["night_total"] == 6
    assert snapshot["assassin_name"] is None

    replacement.disconnect()
    for client in clients:
        client.disconnect()


def test_new_host_tab_revokes_old_host_socket(socket_client, create_game):
    created = create_game(socket_client)
    replacement = server.socketio.test_client(server.app)
    replacement.emit(
        "register_host_screen",
        {
            "game_code": created["room_code"],
            "host_token": created["host_token"],
        },
    )

    assert not socket_client.is_connected()
    assert packets_for(replacement, "host_registered")[0]["code"] == created["room_code"]
    replacement.disconnect()


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


def test_ready_state_is_public_and_host_can_recover_a_disconnected_seat(
    socket_client, create_game
):
    created = create_game(socket_client)
    player = server.socketio.test_client(server.app)
    player.emit("join_game", {"room_code": created["room_code"], "player_name": "Arthur"})
    joined = packets_for(player, "join_success")[0]
    player.get_received()

    player.emit("set_ready", {"ready": True})
    ready_update = packets_for(socket_client, "lobby_update")[-1]
    assert ready_update["players"][0]["ready"] is True
    player.disconnect()
    socket_client.get_received()

    socket_client.emit("request_seat_recovery", {"player_id": joined["player_id"]})
    recovery = packets_for(socket_client, "seat_recovery_code")[0]
    assert recovery["player_name"] == "Arthur"
    assert len(recovery["code"]) == 6

    replacement = server.socketio.test_client(server.app)
    replacement.emit(
        "claim_player_seat",
        {"room_code": created["room_code"], "recovery_code": recovery["code"]},
    )
    recovered = packets_for(replacement, "seat_recovered")[0]
    assert recovered["snapshot"]["my_player_id"] == joined["player_id"]
    assert recovered["session_token"] != joined["session_token"]
    assert server.games[created["room_code"]].players[joined["player_id"]].connected

    stale = server.socketio.test_client(server.app)
    stale.emit("reconnect_game", {"session_token": joined["session_token"]})
    assert packets_for(stale, "reconnect_failed")
    stale.disconnect()
    replacement.disconnect()


def test_malformed_payload_is_controlled(socket_client):
    socket_client.emit("join_game", ["not", "an", "object"])
    errors = packets_for(socket_client, "error")
    assert errors == [{"message": "Invalid request"}]


def test_one_ip_cannot_consume_the_global_connection_pool(monkeypatch):
    monkeypatch.setattr(server, "MAX_CONNECTIONS_PER_IP", 2)
    first = server.socketio.test_client(server.app)
    second = server.socketio.test_client(server.app)
    rejected = server.socketio.test_client(server.app)

    assert first.is_connected()
    assert second.is_connected()
    assert not rejected.is_connected()
    first.disconnect()
    second.disconnect()


def test_join_attempts_are_rate_limited(socket_client):
    for _ in range(16):
        socket_client.emit("join_game", {"room_code": "ABCD", "player_name": "Arthur"})
    messages = [packet["message"] for packet in packets_for(socket_client, "error")]
    assert "Too many requests. Please wait and try again." in messages


def test_only_current_leader_can_advance_completed_mission(socket_client, create_game):
    created = create_game(socket_client)
    player = server.socketio.test_client(server.app)
    player.emit(
        "join_game", {"room_code": created["room_code"], "player_name": "Arthur"}
    )
    player.get_received()
    other = server.socketio.test_client(server.app)
    other.emit(
        "join_game", {"room_code": created["room_code"], "player_name": "Merlin"}
    )
    other.get_received()
    game = server.games[created["room_code"]]
    game.phase = server.GamePhase.MISSION_REVEAL
    game.current_leader_index = 1
    game.pending_mission_outcome = "next_mission"
    player.emit("advance_after_mission")
    assert packets_for(player, "error")[0]["message"] == "You are not the current leader"
    assert game.pending_mission_outcome == "next_mission"
    player.disconnect()
    other.disconnect()


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


def test_host_cannot_reorder_players_with_a_duplicate_name(
    socket_client, create_game
):
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

    socket_client.emit(
        "reorder_players", {"order": ["Arthur", "Merlin", "Arthur"]}
    )

    assert packets_for(socket_client, "error")[-1]["message"] == "Player list mismatch"
    assert [
        server.games[created["room_code"]].players[player_id].name
        for player_id in server.games[created["room_code"]].player_order
    ] == ["Arthur", "Merlin"]
    for player in players:
        player.disconnect()


def test_assassin_targets_are_private_in_reconnect_snapshots(
    socket_client, create_game
):
    created, clients, joined = join_players(socket_client, create_game)
    game = server.games[created["room_code"]]
    server.assign_roles(game)
    game.phase = server.GamePhase.ASSASSIN_PHASE
    assassin = server.get_assassin(game)

    for join in joined:
        snapshot = server.build_state_snapshot(game, join["player_id"])
        if join["player_id"] == assassin.player_id:
            assert snapshot["assassin_id"] == assassin.player_id
            assert {target["name"] for target in snapshot["targets"]} == {
                player.name for player in server.get_assassin_targets(game)
            }
        else:
            assert "assassin_id" not in snapshot
            assert "targets" not in snapshot

    for client in clients:
        client.disconnect()


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
    server.games[stale_code].suspended = True
    server.games[stale_code].expires_at = server.time.time() - 1
    socket_client.emit("create_game")
    new_game = packets_for(socket_client, "game_created")[0]
    assert stale_code not in server.games
    assert new_game["room_code"] in server.games


def test_disconnected_lobby_seat_is_preserved_and_blocks_start(socket_client, create_game):
    created, clients, _ = join_players(socket_client, create_game)
    game = server.games[created["room_code"]]
    clients[0].disconnect()

    socket_client.emit("start_game")

    assert game.phase == server.GamePhase.LOBBY
    assert game.player_count() == 6
    assert any(not player.connected for player in game.players.values())
    assert "must reconnect" in packets_for(socket_client, "error")[-1]["message"]
    for client in clients[1:]:
        client.disconnect()


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


def test_complete_mission_waits_for_leader_before_advancing(socket_client, create_game):
    created, clients, _ = join_players(socket_client, create_game)
    game = server.games[created["room_code"]]

    socket_client.emit("start_game")
    for client in clients:
        client.get_received()
        client.emit("night_phase_ack")
    assert game.phase == server.GamePhase.DISCUSSION

    leader_id = game.current_leader().player_id
    leader_index = game.player_order.index(leader_id)
    clients[leader_index].emit("skip_discussion", {"confirmed": True})
    assert game.timer_kind == "proposal"
    assert game.timer_deadline is not None
    team = game.player_order[: game.mission_size()]
    clients[leader_index].emit("propose_team", {"team": team})
    assert game.votes == {}

    # Team-vote progress is also authoritative when players submit out of
    # display order.
    socket_client.get_received()
    first_voter_id = game.player_order[-1]
    first_voter = clients[game.player_order.index(first_voter_id)]
    first_voter.emit("cast_vote", {"vote": "approve"})
    vote_progress = packets_for(socket_client, "vote_waiting")[-1]
    assert vote_progress == {
        "voted": [game.players[first_voter_id].name],
        "remaining": [
            game.players[pid].name
            for pid in game.player_order
            if pid != first_voter_id
        ],
    }

    for client in clients[:-1]:
        client.emit("cast_vote", {"vote": "approve"})
    assert game.phase == server.GamePhase.VOTE_REVEAL
    assert game.pending_vote_result is not None

    non_leader_index = next(index for index in range(len(clients)) if index != leader_index)
    clients[non_leader_index].emit("confirm_vote_reveal")
    assert game.phase == server.GamePhase.VOTE_REVEAL
    assert packets_for(clients[non_leader_index], "error")[-1]["message"] == "You are not the current leader"

    clients[leader_index].emit("confirm_vote_reveal")
    assert game.phase == server.GamePhase.MISSION
    assert game.pending_vote_result is None
    assert game.proposal_history[0]["approved"] is True
    assert "votes" not in game.proposal_history[0]

    # Progress identifies the player who actually submitted, even when the
    # second displayed team member plays first.
    socket_client.get_received()
    first_player_id = team[-1]
    first_client = clients[game.player_order.index(first_player_id)]
    first_client.emit("play_mission_card", {"card": "success"})
    progress = packets_for(socket_client, "mission_waiting")[-1]
    assert progress == {
        "played": 1,
        "total": len(team),
        "played_player_ids": [first_player_id],
        "remaining_player_ids": team[:-1],
        "played_players": [game.players[first_player_id].name],
        "remaining_players": [game.players[pid].name for pid in team[:-1]],
    }

    for player_id in team[:-1]:
        client = clients[game.player_order.index(player_id)]
        client.emit("play_mission_card", {"card": "success"})
    assert game.phase == server.GamePhase.MISSION_REVEAL
    assert game.pending_mission_outcome == "next_mission"
    assert game.current_mission == 0

    clients[leader_index].emit("advance_after_mission")
    assert game.phase == server.GamePhase.DISCUSSION
    assert game.current_mission == 1
    for client in clients:
        client.disconnect()


def test_fifth_rejected_team_ends_game_without_another_proposal(
    socket_client, create_game
):
    created, clients, _ = join_players(socket_client, create_game)
    game = server.games[created["room_code"]]

    socket_client.emit("start_game")
    for client in clients:
        client.get_received()
        client.emit("night_phase_ack")
    initial_leader_index = game.player_order.index(game.current_leader().player_id)
    clients[initial_leader_index].emit("skip_discussion", {"confirmed": True})

    for attempt in range(1, 6):
        assert game.phase == server.GamePhase.TEAM_PROPOSAL
        leader_index = game.player_order.index(game.current_leader().player_id)
        team = game.player_order[: game.mission_size()]
        clients[leader_index].emit("propose_team", {"team": team})
        for client in clients:
            client.emit("cast_vote", {"vote": "reject"})
        assert game.phase == server.GamePhase.VOTE_REVEAL
        clients[leader_index].emit("confirm_vote_reveal")
        assert game.consecutive_rejections == attempt

    assert game.phase == server.GamePhase.GAME_OVER
    assert game.winner == "evil"
    assert game.win_reason == "rejections"
    final_packets = clients[0].get_received()
    assert len([p for p in final_packets if p["name"] == "game_over"]) == 1
    assert final_packets[-1]["name"] == "game_over"
    assert final_packets[-1]["args"][0]["win_reason"] == "rejections"

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
    leader_index = game.player_order.index(game.current_leader().player_id)
    clients[leader_index].emit("skip_discussion", {"confirmed": True})

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

    leader_index = game.player_order.index(game.current_leader().player_id)
    clients[leader_index].emit("skip_discussion", {"confirmed": True})
    team = game.player_order[: game.mission_size()]
    clients[leader_index].emit("propose_team", {"team": team})
    assert game.votes == {}
    for client in clients:
        client.emit("cast_vote", {"vote": "approve"})
    assert game.phase == server.GamePhase.VOTE_REVEAL
    clients[leader_index].emit("confirm_vote_reveal")
    assert game.phase == server.GamePhase.MISSION
    assert len(game.proposed_team) == server.MISSION_SIZES[player_count][0]

    for client in clients:
        client.disconnect()
