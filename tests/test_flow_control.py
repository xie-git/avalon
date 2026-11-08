"""Waiting lists and host force-continue for all-hands confirmation steps."""

import server


def packets_for(client, event):
    return [
        packet["args"][0] for packet in client.get_received() if packet["name"] == event
    ]


def phone_game_at_mission_reveal(socket_client):
    socket_client.emit("create_player_game", {"player_name": "Arthur"})
    created = packets_for(socket_client, "join_success")[0]
    clients = [socket_client]
    for index in range(1, 6):
        client = server.socketio.test_client(server.app)
        client.emit("join_game", {"room_code": created["room_code"], "player_name": f"Player {index}"})
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
    game.phase_started_at -= 100
    for client in clients:
        client.emit("confirm_vote_reveal")
    for client in clients:
        client.emit("ack_mission_intro")
    for player_id in team:
        clients[game.player_order.index(player_id)].emit("play_mission_card", {"card": "success"})
    assert game.phase == server.GamePhase.MISSION_REVEAL
    for client in clients:
        client.get_received()
    return game, clients


def test_waiting_status_names_the_straggler_and_host_can_force(socket_client):
    game, clients = phone_game_at_mission_reveal(socket_client)
    straggler_id = game.player_order[-1]
    straggler = clients[-1]
    for player_id, client in zip(game.player_order, clients):
        if player_id != straggler_id:
            client.emit("advance_after_mission")
    statuses = packets_for(socket_client, "waiting_status")
    assert statuses[-1]["stage"] == "mission_reveal"
    assert statuses[-1]["pending_names"] == [game.players[straggler_id].name]
    assert statuses[-1]["forceable"] is True
    assert game.phase == server.GamePhase.MISSION_REVEAL

    # Too early: the reveal is still playing.
    socket_client.emit("force_continue")
    assert game.phase == server.GamePhase.MISSION_REVEAL

    # Only the host may force.
    game.phase_started_at -= 60
    clients[1].emit("force_continue")
    assert game.phase == server.GamePhase.MISSION_REVEAL

    socket_client.emit("force_continue")
    assert game.phase != server.GamePhase.MISSION_REVEAL
    assert game.current_mission == 1
    forced = packets_for(straggler, "flow_forced")
    assert forced == [{"stage": "mission_reveal", "skipped_names": [game.players[straggler_id].name]}]


def test_offline_players_are_flagged_in_the_waiting_list(socket_client):
    game, clients = phone_game_at_mission_reveal(socket_client)
    clients[-1].disconnect()
    statuses = packets_for(socket_client, "waiting_status")
    offline_name = game.players[game.player_order[-1]].name
    assert offline_name in statuses[-1]["offline_names"]


def test_votes_and_quest_cards_are_never_forceable(socket_client):
    game, clients = phone_game_at_mission_reveal(socket_client)
    game.phase = server.GamePhase.TEAM_VOTE
    game.votes = {}
    wait = server.current_wait(game)
    assert wait["stage"] == "vote" and wait["forceable"] is False
    game.phase = server.GamePhase.MISSION
    game.mission_choices_open = True
    game.mission_cards = {}
    assert server.current_wait(game)["forceable"] is False


def test_lone_offline_straggler_can_earn_a_narrator_nudge(socket_client, monkeypatch):
    game, clients = phone_game_at_mission_reveal(socket_client)
    monkeypatch.setattr(server.secure_random, "random", lambda: 0.0)
    clients[-1].disconnect()
    for client in clients[:-1]:
        client.emit("advance_after_mission")
    wait = server.current_wait(game)
    assert len(wait["pending"]) == 1 and wait["offline_names"]
    scheduled = [entry["message"]["trigger_id"] for entry in game.narrator_runtime.get("scheduled", [])]
    assert 103 in scheduled
