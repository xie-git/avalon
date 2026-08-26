import json
import sqlite3

import server
from chat_store import ChatStore
from game_logic import GameState, add_player, assign_roles
from research_history import build_bundle, build_wrapped, redact_bundle, validate_stream
from research_telemetry import RULESET_VERSION, replay_state, sha256_json


def packets_for(client, event):
    return [
        packet["args"][0]
        for packet in client.get_received()
        if packet["name"] == event
    ]


def research_game_values(game_id="game-1", initial_state=None):
    initial_state = initial_state or {"phase": "ROLE_ASSIGNMENT"}
    return {
        "game_id": game_id,
        "party_id": "party-1",
        "room_code": "abcd",
        "ruleset_version": RULESET_VERSION,
        "app_version": "test",
        "started_at": "2026-08-24T12:00:00.000Z",
        "started_at_unix": 1_777_115_200.0,
        "player_count": 1,
        "human_count": 1,
        "spectator_count": 0,
        "settings": {"discussion_seconds": 60, "proposal_seconds": 60},
        "role_set": [{"role": "Merlin", "team": "good"}],
        "initial_state": initial_state,
    }


def participant_values(game_id="game-1", won=None):
    return {
        "game_id": game_id,
        "participant_id": "player-1",
        "participant_type": "player",
        "subject_id": "subject-test",
        "display_name": "Arthur",
        "seat_index": 0,
        "role": "Merlin",
        "team": "good",
        "is_bot": False,
        "is_host_player": True,
        "color_index": 0,
        "avatar_index": 0,
        "avatar_source": "built_in",
        "selfie_sha256": None,
        "vision_mode": None,
        "first_seen_at": "2026-08-24T12:00:00.000Z",
        "last_seen_at": "2026-08-24T12:30:00.000Z",
        "won": won,
    }


def terminal_game_values(game_id="game-1"):
    return {
        "game_id": game_id,
        "status": "completed",
        "ended_at": "2026-08-24T12:30:00.000Z",
        "ended_at_unix": 1_777_117_000.0,
        "winner": "good",
        "win_reason": "assassination_failed",
        "wall_duration_ms": 1_800_000,
        "active_duration_ms": 1_700_000,
        "mission_count": 3,
        "proposal_count": 4,
        "successful_missions": 3,
        "failed_missions": 0,
        "assassination_target_player_id": "player-1",
        "final_state": {"phase": "GAME_OVER", "winner": "good"},
        "abandonment_reason": None,
    }


def save_event(store, event_type, *, payload=None, actor_id="player-1", state=None):
    return store.save_research_event(
        stream_id="game-1",
        stream_type="game",
        app_version="test",
        event_type=event_type,
        source="product",
        category="gameplay",
        visibility="research_secret",
        actor_type="player",
        actor_id=actor_id,
        subject_id="subject-test",
        payload=payload or {},
        party_id="party-1",
        room_code="ABCD",
        game_id="game-1",
        phase="TEAM_VOTE",
        mission_num=1,
        proposal_attempt=1,
        state=state,
    )


def test_replay_state_contains_hidden_game_facts_but_no_capabilities_or_image_bytes():
    game = GameState("SAFE")
    for index in range(6):
        player = add_player(game, f"Player {index}", f"player-{index}")
        player.session_token = "raw-secret"
        player.session_token_hash = "hashed-secret"
    assign_roles(game)
    game.game_id = "game-1"
    game.started_at = 100.0
    game.host_token = "raw-host-secret"
    game.host_token_hash = "hashed-host-secret"
    first = game.players[game.player_order[0]]
    first.avatar_image = "data:image/jpeg;base64,private-bytes"
    first.selfie_sha256 = "a" * 64
    game.votes[first.player_id] = "approve"
    game.mission_cards[first.player_id] = "success"

    state = replay_state(game, captured_at=101.0)
    encoded = json.dumps(state)

    assert state["private_action_state"]["votes_by_player_id"][first.player_id] == "approve"
    assert state["private_action_state"]["mission_cards_by_player_id"][first.player_id] == "success"
    assert state["roster"]["players"][0]["selfie_sha256"] == "a" * 64
    assert "raw-secret" not in encoded
    assert "hashed-secret" not in encoded
    assert "raw-host-secret" not in encoded
    assert "hashed-host-secret" not in encoded
    assert "private-bytes" not in encoded


def test_research_streams_are_ordered_hash_chained_deduplicated_and_validated(tmp_path):
    store = ChatStore(str(tmp_path / "research.sqlite3"))
    store.initialize()

    first = save_event(store, "vote_submitted", payload={"choice": "approve"})
    checkpoint = save_event(
        store,
        "state_checkpoint",
        payload={"reason": "action"},
        state={"phase": "TEAM_VOTE", "votes": {"player-1": "approve"}},
    )
    duplicate_checkpoint = save_event(
        store,
        "state_checkpoint",
        payload={"reason": "duplicate"},
        state={"phase": "TEAM_VOTE", "votes": {"player-1": "approve"}},
    )

    rows = store.research_events(stream_id="game-1")
    assert first["sequence_no"] == 1
    assert checkpoint["sequence_no"] == 2
    assert duplicate_checkpoint is None
    assert [row["sequence_no"] for row in rows] == [1, 2]
    assert rows[1]["previous_event_hash"] == rows[0]["event_hash"]
    assert rows[1]["state_hash"] == sha256_json(json.loads(rows[1]["state_json"]))
    assert validate_stream(store, "game-1")["valid"] is True
    with store._connect() as connection:
        document = json.loads(rows[0]["event_json"])
        document["data"]["choice"] = "reject"
        connection.execute(
            "UPDATE research_events SET event_json = ? WHERE event_id = ?",
            (json.dumps(document), rows[0]["event_id"]),
        )
        connection.commit()
    invalid = validate_stream(store, "game-1")
    assert invalid["valid"] is False
    assert any("invalid event hash" in error for error in invalid["errors"])


def test_existing_chat_database_is_migrated_additively(tmp_path):
    path = tmp_path / "existing.sqlite3"
    with sqlite3.connect(path) as connection:
        connection.execute(
            """
            CREATE TABLE chat_messages (
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
            "INSERT INTO chat_messages "
            "(created_at, room_code, player_name, message) VALUES (?, ?, ?, ?)",
            ("2026-08-24T12:00:00Z", "ABCD", "Arthur", "hello"),
        )
    store = ChatStore(str(path))

    store.initialize()

    with store._connect() as connection:
        columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(chat_messages)")
        }
        original = connection.execute(
            "SELECT player_name, message FROM chat_messages"
        ).fetchone()
        research_tables = {
            row["name"]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
    assert {"message_id", "game_id", "actor_id", "subject_id", "phase"} <= columns
    assert tuple(original) == ("Arthur", "hello")
    assert {"research_events", "research_games", "research_participants"} <= research_tables


def test_bundle_is_self_contained_and_redaction_removes_names_subjects_and_chat(tmp_path):
    store = ChatStore(str(tmp_path / "bundle.sqlite3"))
    store.start_research_game(
        game=research_game_values(
            initial_state={
                "identity": {"room_code": "ABCD"},
                "roster": {"players": [{"display_name": "Arthur"}]},
            }
        ),
        participants=[participant_values()],
    )
    save_event(store, "game_started", payload={"leader_name": "Arthur"})
    store.finalize_research_game(
        game=terminal_game_values(),
        participants=[participant_values(won=True)],
    )
    store.save(
        room_code="ABCD",
        game_started_at=1_777_115_200.0,
        player_name="Arthur",
        message="Merlin is here",
        game_id="game-1",
        party_id="party-1",
        actor_type="player",
        actor_id="player-1",
        subject_id="subject-test",
    )

    bundle = build_bundle(store, "game-1", include_chat=True)
    redacted = build_bundle(store, "game-1", include_chat=True, redact=True)

    assert bundle["manifest"]["event_count"] == 1
    assert bundle["participants"][0]["display_name"] == "Arthur"
    assert bundle["chat"][0]["message"] == "Merlin is here"
    encoded = json.dumps(redacted)
    assert redacted["manifest"]["redacted"] is True
    assert redacted["chat"][0]["message"] == "[redacted]"
    assert "Arthur" not in encoded
    assert "subject-test" not in encoded
    assert "Merlin is here" not in encoded


def test_redaction_does_not_confuse_a_display_name_with_a_role_name():
    bundle = {
        "manifest": {"redacted": False},
        "participants": [
            {
                "participant_type": "player",
                "display_name": "Merlin",
                "role": "Merlin",
                "subject_id": "subject-test",
                "selfie_sha256": "a" * 64,
            }
        ],
        "game": {"role_set": [{"role": "Merlin", "team": "good"}]},
        "timeline": [],
    }

    redacted = redact_bundle(bundle)

    assert redacted["participants"][0]["display_name"] == "Player 1"
    assert redacted["participants"][0]["role"] == "Merlin"
    assert redacted["game"]["role_set"][0]["role"] == "Merlin"


def test_wrapped_derives_visualization_ready_player_metrics(tmp_path):
    store = ChatStore(str(tmp_path / "wrapped.sqlite3"))
    store.start_research_game(
        game=research_game_values(), participants=[participant_values()]
    )
    save_event(
        store,
        "team_proposal_submitted",
        payload={"team_ids": ["player-1"], "decision_ms": 1500},
    )
    save_event(store, "team_vote", payload={"approved": True}, actor_id=None)
    save_event(
        store,
        "vote_submitted",
        payload={"choice": "approve", "decision_ms": 700},
    )
    save_event(
        store,
        "mission_card_submitted",
        payload={"card": "success", "decision_ms": 400},
    )
    save_event(store, "chat_sent", payload={"message_length": 12})
    store.finalize_research_game(
        game=terminal_game_values(),
        participants=[participant_values(won=True)],
    )

    wrapped = build_wrapped(store, "subject-test", year=2026)

    assert wrapped["headline"]["games_completed"] == 1
    assert wrapped["headline"]["win_rate_percent"] == 100.0
    assert wrapped["identity"]["favorite_role"] == "Merlin"
    assert wrapped["table_style"]["approval_rate_percent"] == 100.0
    assert wrapped["table_style"]["leadership_approval_rate_percent"] == 100.0
    assert wrapped["quests"]["quests_played"] == 1
    assert wrapped["social_and_app"]["chat_messages"] == 1
    assert len(wrapped["cards"]) >= 5
    with store._connect() as connection:
        proposal = connection.execute(
            "SELECT * FROM research_proposal_facts WHERE game_id = 'game-1'"
        ).fetchone()
        player_stats = connection.execute(
            "SELECT * FROM research_player_game_stats WHERE game_id = 'game-1'"
        ).fetchone()
    assert proposal["leader_player_id"] == "player-1"
    assert proposal["approved"] == 1
    assert player_stats["votes_cast"] == 1
    assert player_stats["missions_joined"] == 1
    assert player_stats["chat_messages"] == 1


def test_server_starts_normalized_game_and_writes_safe_replay_checkpoint(
    tmp_path, monkeypatch, socket_client, create_game
):
    store = ChatStore(str(tmp_path / "server-research.sqlite3"))
    store.initialize()
    monkeypatch.setattr(server, "chat_store", store)
    monkeypatch.setitem(server.app.config, "PERSIST_ROOMS_IN_TESTS", True)
    created = create_game(socket_client)
    clients = []
    for index in range(6):
        client = server.socketio.test_client(server.app)
        client.emit(
            "join_game",
            {
                "room_code": created["room_code"],
                "player_name": f"Player {index}",
                "analytics_id": f"00000000-0000-4000-8000-{index + 1:012d}",
            },
        )
        assert packets_for(client, "join_success")
        clients.append(client)

    socket_client.emit("start_game")
    game = server.games[created["room_code"]]
    game_row = store.research_game(game.game_id)
    rows = store.research_events(game_id=game.game_id)

    assert game_row["status"] == "in_progress"
    assert game_row["player_count"] == 6
    assert len(store.research_participants(game.game_id)) == 6
    assert "game_started" in [row["event_type"] for row in rows]
    checkpoints = [row for row in rows if row["state_json"]]
    assert checkpoints
    encoded = checkpoints[-1]["state_json"]
    assert "session_token" not in encoded
    assert "host_token" not in encoded
    assert "avatar_image" not in encoded
    assert validate_stream(store, game.game_id)["valid"] is True
    for client in clients:
        client.disconnect()


def test_client_envelope_is_deduplicated_and_sessionized_without_raw_browser_id(
    tmp_path, monkeypatch, socket_client, create_game
):
    store = ChatStore(str(tmp_path / "client-session.sqlite3"))
    store.initialize()
    monkeypatch.setattr(server, "chat_store", store)
    created = create_game(socket_client)
    analytics_id = "11111111-1111-4111-8111-111111111111"
    player = server.socketio.test_client(server.app)
    player.emit(
        "join_game",
        {
            "room_code": created["room_code"],
            "player_name": "Arthur",
            "analytics_id": analytics_id,
        },
    )
    game = server.games[created["room_code"]]
    envelope = {
        "analytics_id": analytics_id,
        "client_session_id": "22222222-2222-4222-8222-222222222222",
        "client_event_id": "33333333-3333-4333-8333-333333333333",
        "client_sequence": 1,
        "client_occurred_at": "2026-08-24T12:00:00.000Z",
        "client_uptime_ms": 1234,
        "page": "player",
        "client_context": {
            "screen_class": "phone",
            "viewport_width_bucket": "xs",
            "touch_capable": True,
        },
        "event_type": "screen_viewed",
        "payload": {"screen_id": "screen-lobby", "context": "player"},
    }

    player.emit("client_analytics", envelope)
    player.emit("client_analytics", envelope)

    rows = [
        row
        for row in store.research_events(stream_id=game.party_id)
        if row["event_type"] == "screen_viewed"
    ]
    sessions = store.research_client_sessions(
        subject_id=server.research_subject_id(analytics_id)
    )
    assert len(rows) == 1
    assert rows[0]["client_session_id"] == envelope["client_session_id"]
    assert rows[0]["client_sequence"] == 1
    assert analytics_id not in rows[0]["event_json"]
    assert len(sessions) == 1
    assert sessions[0]["event_count"] == 1
    assert json.loads(sessions[0]["initial_context_json"])["screen_class"] == "phone"
    player.disconnect()
