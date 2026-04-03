import uuid
import eventlet
eventlet.monkey_patch()

from flask import Flask, render_template, request, session
from flask_socketio import SocketIO, emit, join_room, leave_room

from game_logic import (
    GameState, GamePhase, Role, Team,
    generate_game_code, add_player, remove_player, reorder_players,
    assign_roles, get_night_phase_info,
    validate_team_proposal, record_vote, process_vote_result,
    record_mission_card, process_mission_result,
    get_assassin, process_assassination, get_game_summary,
    build_state_snapshot, MISSION_SIZES,
)

import os
import time as _time
app = Flask(__name__)
app.config["SECRET_KEY"] = "avalon-secret-key-change-in-prod"
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0  # Disable static file caching
socketio = SocketIO(app, async_mode="eventlet", cors_allowed_origins="*")

@app.after_request
def no_cache(response):
    if request.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-store"
    return response

# ---------------------------------------------------------------------------
# Global state
# ---------------------------------------------------------------------------
games: dict[str, GameState] = {}           # code -> GameState
sid_to_info: dict[str, dict] = {}          # sid -> {game_code, player_id, is_host_screen}
session_tokens: dict[str, tuple] = {}       # token -> (game_code, player_id)

HOST_IP = os.environ.get("HOST_IP", "localhost")
PORT = int(os.environ.get("PORT", 5001))

# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def player_screen():
    return render_template("player.html")

@app.route("/host")
def host_screen():
    return render_template("host.html")

@app.route("/dev")
def dev_screen():
    return render_template("dev.html")

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def emit_to_game(game_code: str, event: str, data: dict):
    socketio.emit(event, data, room=game_code)

def emit_to_player(sid: str, event: str, data: dict):
    socketio.emit(event, data, room=sid)

def get_game(game_code: str) -> GameState | None:
    return games.get(game_code)

def get_caller_info(sid: str) -> dict | None:
    return sid_to_info.get(sid)

def validate_caller(sid: str, require_phase=None, require_leader=False, require_assassin=False):
    """Returns (game, player) or raises ValueError."""
    info = sid_to_info.get(sid)
    if not info:
        raise ValueError("Not connected to a game")
    game = games.get(info["game_code"])
    if not game:
        raise ValueError("Game not found")
    player_id = info.get("player_id")
    if not player_id:
        raise ValueError("Not a player")
    player = game.players.get(player_id)
    if not player:
        raise ValueError("Player not found")
    if require_phase and game.phase != require_phase:
        raise ValueError(f"Wrong game phase: {game.phase}")
    if require_leader:
        leader = game.current_leader()
        if not leader or leader.player_id != player_id:
            raise ValueError("You are not the current leader")
    if require_assassin:
        assassin = get_assassin(game)
        if not assassin or assassin.player_id != player_id:
            raise ValueError("You are not the Assassin")
    return game, player

# ---------------------------------------------------------------------------
# Background task: Discussion timer
# ---------------------------------------------------------------------------

def run_discussion_timer(game_code: str, phase_key: str, duration: int):
    for remaining in range(duration, -1, -1):
        eventlet.sleep(1)
        game = games.get(game_code)
        if not game or game.timer_phase_key != phase_key:
            return  # cancelled or phase changed
        emit_to_game(game_code, "discussion_tick", {"remaining_seconds": remaining})
    game = games.get(game_code)
    if game and game.timer_phase_key == phase_key:
        transition_to_team_proposal(game)


def run_proposal_timer(game_code: str, phase_key: str, duration: int):
    for remaining in range(duration, -1, -1):
        eventlet.sleep(1)
        game = games.get(game_code)
        if not game or game.timer_phase_key != phase_key:
            return
        emit_to_game(game_code, "proposal_tick", {"remaining_seconds": remaining})
    # Timer expired — just notify host, don't auto-advance (advisory timer)
    game = games.get(game_code)
    if game and game.timer_phase_key == phase_key:
        emit_to_game(game_code, "proposal_timer_expired", {})


# ---------------------------------------------------------------------------
# Phase transition helpers
# ---------------------------------------------------------------------------

def start_round(game: GameState):
    game.phase = GamePhase.ROUND_START
    leader = game.current_leader()
    player_count = game.player_count()
    mission_sizes = MISSION_SIZES.get(player_count, [])
    emit_to_game(game.code, "round_start", {
        "mission_num": game.current_mission + 1,  # 1-indexed for display
        "leader_name": leader.name if leader else "Unknown",
        "leader_id": leader.player_id if leader else None,
        "mission_size": game.mission_size(),
        "reject_count": game.consecutive_rejections,
        "mission_results": game.mission_results,
        "mission_sizes": mission_sizes,
        "requires_double_fail": game.requires_double_fail(),
        # Player ordering info — needed by the leader's proposal screen
        "player_order": [game.players[pid].name for pid in game.player_order],
        "player_name_to_id": {game.players[pid].name: pid for pid in game.player_order},
    })
    # Immediately go to discussion
    game.phase = GamePhase.DISCUSSION
    phase_key = str(uuid.uuid4())
    game.timer_phase_key = phase_key
    emit_to_game(game.code, "discussion_start", {
        "duration_seconds": game.discussion_time,
        "mission_num": game.current_mission + 1,
    })
    socketio.start_background_task(run_discussion_timer, game.code, phase_key, game.discussion_time)


def transition_to_team_proposal(game: GameState):
    game.phase = GamePhase.TEAM_PROPOSAL
    game.proposed_team = []
    game.votes = {}
    game.mission_cards = {}
    leader = game.current_leader()
    phase_key = str(uuid.uuid4())
    game.timer_phase_key = phase_key
    emit_to_game(game.code, "proposal_start", {
        "leader_name": leader.name if leader else "Unknown",
        "leader_id": leader.player_id if leader else None,
        "mission_size": game.mission_size(),
        "player_order": [game.players[pid].name for pid in game.player_order],
        "player_name_to_id": {game.players[pid].name: pid for pid in game.player_order},
    })


def transition_to_night_phase(game: GameState):
    game.phase = GamePhase.NIGHT_PHASE
    game.night_acks = set()
    emit_to_game(game.code, "night_phase_start", {
        "total_players": game.player_count()
    })
    # Send private role info to each player
    for pid, player in game.players.items():
        if player.sid:
            night_info = get_night_phase_info(game, pid)
            emit_to_player(player.sid, "role_assigned", {
                "role": player.role,
                "team": player.team,
                "night_info": night_info,
            })


# ---------------------------------------------------------------------------
# SocketIO events
# ---------------------------------------------------------------------------

@socketio.on("connect")
def on_connect():
    pass  # Just establishing connection


@socketio.on("disconnect")
def on_disconnect():
    sid = request.sid
    info = sid_to_info.pop(sid, None)
    if not info:
        return
    game_code = info["game_code"]
    game = games.get(game_code)
    if not game:
        return
    if info.get("is_host_screen"):
        game.host_sid = None
        return
    player_id = info.get("player_id")
    if player_id and player_id in game.players:
        game.players[player_id].connected = False
        game.players[player_id].sid = None
        emit_to_game(game_code, "player_disconnected", {
            "player_id": player_id,
            "player_name": game.players[player_id].name,
            "players": game.public_players(),
        })


# --- Host screen registration ---

@socketio.on("register_host_screen")
def on_register_host_screen(data):
    sid = request.sid
    game_code = data.get("game_code", "").upper()
    game = games.get(game_code)
    if game:
        game.host_sid = sid
        join_room(game_code)
        sid_to_info[sid] = {"game_code": game_code, "is_host_screen": True}
        player_count = game.player_count()
        emit("host_registered", {
            "code": game_code,
            "players": game.public_players(),
            "phase": game.phase,
            "mission_sizes": MISSION_SIZES.get(player_count, []),
            "mission_results": game.mission_results,
            "current_mission": game.current_mission,
            "consecutive_rejections": game.consecutive_rejections,
            "current_leader": game.current_leader().name if game.current_leader() else "",
            "discussion_time": game.discussion_time,
        })
    else:
        emit("error", {"message": "Game not found"})


# --- Create game (host screen initiates) ---

@socketio.on("create_game")
def on_create_game():
    sid = request.sid
    code = generate_game_code(set(games.keys()))
    game = GameState(code)
    games[code] = game
    game.host_sid = sid
    join_room(code)
    sid_to_info[sid] = {"game_code": code, "is_host_screen": True}
    emit("game_created", {
        "room_code": code,
        "join_url": f"http://{HOST_IP}:{PORT}",
    })


# --- Player joins ---

@socketio.on("join_game")
def on_join_game(data):
    sid = request.sid
    code = data.get("room_code", "").upper().strip()
    name = data.get("player_name", "").strip()
    game = games.get(code)
    if not game:
        emit("error", {"message": "Room not found. Check the code and try again."})
        return
    try:
        player_id = str(uuid.uuid4())
        player = add_player(game, name, player_id)
    except ValueError as e:
        emit("error", {"message": str(e)})
        return
    token = str(uuid.uuid4())
    player.session_token = token
    player.sid = sid
    session_tokens[token] = (code, player_id)
    join_room(code)
    sid_to_info[sid] = {"game_code": code, "player_id": player_id}
    emit("join_success", {
        "player_id": player_id,
        "session_token": token,
        "player_name": player.name,
        "is_host": player_id == game.host_player_id,
        "room_code": code,
        "players": game.public_players(),
        "settings": {"discussion_time": game.discussion_time, "proposal_time": game.proposal_time},
    })
    emit_to_game(code, "player_joined", {
        "new_player": player.name,
        "players": game.public_players(),
        "player_count": game.player_count(),
    })


# --- Reconnect ---

@socketio.on("reconnect_game")
def on_reconnect_game(data):
    sid = request.sid
    token = data.get("session_token")
    entry = session_tokens.get(token)
    if not entry:
        emit("error", {"message": "Session not found. Please rejoin."})
        return
    game_code, player_id = entry
    game = games.get(game_code)
    if not game:
        emit("error", {"message": "Game no longer exists."})
        return
    player = game.players.get(player_id)
    if not player:
        emit("error", {"message": "Player not found in game."})
        return
    old_sid = player.sid
    if old_sid and old_sid in sid_to_info:
        del sid_to_info[old_sid]
    player.sid = sid
    player.connected = True
    join_room(game_code)
    sid_to_info[sid] = {"game_code": game_code, "player_id": player_id}
    snapshot = build_state_snapshot(game, player_id)
    emit("state_snapshot", snapshot)
    emit_to_game(game_code, "player_reconnected", {
        "player_id": player_id,
        "player_name": player.name,
        "players": game.public_players(),
    })


# --- Lobby management ---

@socketio.on("reorder_players")
def on_reorder_players(data):
    sid = request.sid
    try:
        game, player = validate_caller(sid)
    except ValueError as e:
        emit("error", {"message": str(e)}); return
    if player.player_id != game.host_player_id:
        emit("error", {"message": "Only the host can reorder players"}); return
    ordered_names = data.get("player_order", [])
    try:
        reorder_players(game, ordered_names)
    except ValueError as e:
        emit("error", {"message": str(e)}); return
    emit_to_game(game.code, "lobby_update", {
        "players": game.public_players(),
        "settings": {"discussion_time": game.discussion_time, "proposal_time": game.proposal_time},
    })


@socketio.on("update_settings")
def on_update_settings(data):
    sid = request.sid
    info = sid_to_info.get(sid)
    if not info:
        emit("error", {"message": "Not connected to a game"}); return
    game = games.get(info["game_code"])
    if not game:
        emit("error", {"message": "Game not found"}); return
    # Allow both the host screen and the host player to change settings
    if not info.get("is_host_screen"):
        player_id = info.get("player_id")
        if not player_id or player_id != game.host_player_id:
            emit("error", {"message": "Only the host can change settings"}); return
    if game.phase != GamePhase.LOBBY:
        return  # silently ignore during gameplay
    if "discussion_time" in data:
        game.discussion_time = max(10, min(600, int(data["discussion_time"])))
    if "proposal_time" in data:
        game.proposal_time = max(30, min(120, int(data["proposal_time"])))
    emit_to_game(game.code, "lobby_update", {
        "players": game.public_players(),
        "settings": {"discussion_time": game.discussion_time, "proposal_time": game.proposal_time},
    })


@socketio.on("preview_team")
def on_preview_team(data):
    """Leader broadcasts their in-progress team selection to host screen."""
    sid = request.sid
    info = sid_to_info.get(sid)
    if not info:
        return
    game = games.get(info["game_code"])
    if not game or game.phase != GamePhase.TEAM_PROPOSAL:
        return
    # Broadcast the preview (names only, not IDs) to the room
    names = data.get("team_names", [])
    emit_to_game(game.code, "team_preview", {"team_names": names})


@socketio.on("start_game")
def on_start_game():
    sid = request.sid
    info = sid_to_info.get(sid)
    if not info:
        emit("error", {"message": "Not connected to a game"}); return
    game = games.get(info["game_code"])
    if not game:
        emit("error", {"message": "Game not found"}); return
    if game.phase != GamePhase.LOBBY:
        emit("error", {"message": "Game has already started"}); return
    # Allow host screen OR host player to start
    if not info.get("is_host_screen"):
        player_id = info.get("player_id")
        if not player_id or player_id != game.host_player_id:
            emit("error", {"message": "Only the host can start the game"}); return
    n = game.player_count()
    if n < 6 or n > 10:
        emit("error", {"message": f"Need 6-10 players. Currently {n}."}); return
    assign_roles(game)
    emit_to_game(game.code, "game_starting", {"player_count": n})
    eventlet.sleep(1)  # Brief delay for animation
    transition_to_night_phase(game)


# --- Night phase ---

@socketio.on("night_phase_ack")
def on_night_phase_ack():
    sid = request.sid
    try:
        game, player = validate_caller(sid, require_phase=GamePhase.NIGHT_PHASE)
    except ValueError as e:
        emit("error", {"message": str(e)}); return
    if player.player_id in game.night_acks:
        return  # Already acked, ignore duplicate
    game.night_acks.add(player.player_id)
    confirmed = len(game.night_acks)
    total = game.player_count()
    emit_to_game(game.code, "night_phase_progress", {
        "confirmed": confirmed,
        "total": total,
    })
    if confirmed >= total:
        game.phase = GamePhase.ROUND_START  # Prevent re-entry
        emit_to_game(game.code, "night_phase_complete", {})
        eventlet.sleep(1)
        start_round(game)


# --- Discussion ---

@socketio.on("skip_discussion")
def on_skip_discussion(data):
    sid = request.sid
    info = sid_to_info.get(sid)
    if not info:
        emit("error", {"message": "Not connected to a game"}); return
    game = games.get(info["game_code"])
    if not game:
        emit("error", {"message": "Game not found"}); return
    if game.phase != GamePhase.DISCUSSION:
        emit("error", {"message": f"Not in discussion phase (phase={game.phase})"}); return
    if not info.get("is_host_screen"):
        player_id = info.get("player_id")
        if not player_id or player_id != game.host_player_id:
            emit("error", {"message": "Only the host can skip discussion"}); return
    game.timer_phase_key = None  # Cancel timer
    emit_to_game(game.code, "discussion_end", {})
    transition_to_team_proposal(game)


# --- Team proposal ---

@socketio.on("propose_team")
def on_propose_team(data):
    sid = request.sid
    try:
        game, player = validate_caller(sid, require_phase=GamePhase.TEAM_PROPOSAL, require_leader=True)
    except ValueError as e:
        emit("error", {"message": str(e)}); return
    team_ids = data.get("team", [])
    try:
        validate_team_proposal(game, team_ids)
    except ValueError as e:
        emit("error", {"message": str(e)}); return
    game.proposed_team = team_ids
    game.timer_phase_key = None  # Cancel proposal timer
    game.phase = GamePhase.TEAM_VOTE
    team_names = [game.players[pid].name for pid in team_ids]
    # Leader is auto-approved — they do not cast a vote
    game.votes[player.player_id] = "approve"
    emit_to_game(game.code, "team_proposed", {
        "team": team_names,
        "team_ids": team_ids,
        "leader_name": player.name,
    })
    emit_to_game(game.code, "vote_start", {
        "team": team_names,
        "team_ids": team_ids,
        "leader_name": player.name,
    })


@socketio.on("skip_proposal_timer")
def on_skip_proposal_timer():
    sid = request.sid
    info = sid_to_info.get(sid)
    if not info:
        emit("error", {"message": "Not connected to a game"}); return
    game = games.get(info["game_code"])
    if not game:
        emit("error", {"message": "Game not found"}); return
    if game.phase != GamePhase.TEAM_PROPOSAL:
        return  # Silently ignore if not in proposal phase
    if not info.get("is_host_screen"):
        player_id = info.get("player_id")
        if not player_id or player_id != game.host_player_id:
            emit("error", {"message": "Only the host can skip the proposal timer"}); return
    game.timer_phase_key = None
    emit_to_game(game.code, "proposal_timer_expired", {})


# --- Voting ---

@socketio.on("cast_vote")
def on_cast_vote(data):
    sid = request.sid
    try:
        game, player = validate_caller(sid, require_phase=GamePhase.TEAM_VOTE)
    except ValueError as e:
        emit("error", {"message": str(e)}); return
    vote = data.get("vote")
    try:
        result = record_vote(game, player.player_id, vote)
    except ValueError as e:
        emit("error", {"message": str(e)}); return
    emit("vote_cast_ack", {}, room=sid)
    voted_names = [game.players[pid].name for pid in game.votes]
    remaining_names = [p.name for p in game.players.values() if p.player_id not in game.votes]
    emit_to_game(game.code, "vote_waiting", {
        "voted": voted_names,
        "remaining": remaining_names,
    })
    if result:
        game.phase = GamePhase.VOTE_REVEAL
        emit_to_game(game.code, "vote_reveal", result)
        eventlet.sleep(3)  # Dramatic pause for reveal animation
        outcome = process_vote_result(game, result["approved"])
        if outcome == "mission":
            emit_to_game(game.code, "mission_start", {
                "team": [game.players[pid].name for pid in game.proposed_team],
                "team_ids": game.proposed_team,
                "mission_num": game.current_mission + 1,
            })
        elif outcome == "evil_wins_by_rejection":
            emit_to_game(game.code, "evil_wins_by_rejection", {})
            eventlet.sleep(2)
            emit_to_game(game.code, "game_over", get_game_summary(game))
        else:  # next_proposal
            emit_to_game(game.code, "rejection_warning", {
                "consecutive": game.consecutive_rejections,
                "leader_name": game.current_leader().name if game.current_leader() else "Unknown",
            })
            eventlet.sleep(2)
            transition_to_team_proposal(game)


# --- Mission ---

@socketio.on("play_mission_card")
def on_play_mission_card(data):
    sid = request.sid
    try:
        game, player = validate_caller(sid, require_phase=GamePhase.MISSION)
    except ValueError as e:
        emit("error", {"message": str(e)}); return
    card = data.get("card")
    try:
        result = record_mission_card(game, player.player_id, card)
    except ValueError as e:
        emit("error", {"message": str(e)}); return
    emit("mission_card_ack", {}, room=sid)
    played = len(game.mission_cards)
    total = len(game.proposed_team)
    emit_to_game(game.code, "mission_waiting", {"played": played, "total": total})
    if result:
        game.phase = GamePhase.MISSION_REVEAL
        emit_to_game(game.code, "mission_reveal", {
            "cards_shuffled": result["cards_shuffled"],
            "fail_count": result["fail_count"],
            "success_count": result["success_count"],
            "passed": result["passed"],
            "mission_num": game.current_mission + 1,
            "requires_double_fail": game.requires_double_fail(),
        })
        eventlet.sleep(4)  # Animation time
        outcome = process_mission_result(game, result["passed"])
        emit_to_game(game.code, "mission_tracker_update", {
            "mission_results": game.mission_results,
            "good_wins": game.good_wins(),
            "evil_wins": game.evil_wins_count(),
        })
        # Store outcome and wait for host to click "Next Round"
        game.pending_mission_outcome = outcome
        emit_to_game(game.code, "mission_complete", {
            "outcome": outcome,
            "passed": result["passed"],
            "good_wins": game.good_wins(),
            "evil_wins": game.evil_wins_count(),
        })


# --- Advance after mission (host clicks "Next Round") ---

@socketio.on("advance_after_mission")
def on_advance_after_mission():
    sid = request.sid
    info = sid_to_info.get(sid)
    if not info:
        emit("error", {"message": "Not connected"}); return
    game = games.get(info["game_code"])
    if not game:
        emit("error", {"message": "Game not found"}); return
    outcome = game.pending_mission_outcome
    if not outcome:
        return  # already advanced or not waiting
    game.pending_mission_outcome = None
    if outcome == "assassin_phase":
        assassin = get_assassin(game)
        emit_to_game(game.code, "assassin_phase_start", {
            "assassin_name": assassin.name if assassin else "Unknown",
            "assassin_id": assassin.player_id if assassin else None,
            "targets": [
                {"name": p.name, "player_id": p.player_id}
                for p in game.players.values()
                if p.player_id != (assassin.player_id if assassin else None)
            ],
        })
    elif outcome == "evil_wins":
        emit_to_game(game.code, "game_over", get_game_summary(game))
    else:  # next_mission
        start_round(game)


# --- Assassination ---

@socketio.on("assassinate")
def on_assassinate(data):
    sid = request.sid
    try:
        game, player = validate_caller(sid, require_phase=GamePhase.ASSASSIN_PHASE, require_assassin=True)
    except ValueError as e:
        emit("error", {"message": str(e)}); return
    target_id = data.get("target_player_id")
    try:
        result = process_assassination(game, target_id)
    except ValueError as e:
        emit("error", {"message": str(e)}); return
    emit_to_game(game.code, "assassination_result", result)
    eventlet.sleep(3)
    emit_to_game(game.code, "game_over", get_game_summary(game))


# --- Return to lobby ---

@socketio.on("return_to_lobby")
def on_return_to_lobby():
    sid = request.sid
    info = sid_to_info.get(sid)
    if not info:
        emit("error", {"message": "Not connected to a game"}); return
    game = games.get(info["game_code"])
    if not game:
        emit("error", {"message": "Game not found"}); return
    if not info.get("is_host_screen"):
        player_id = info.get("player_id")
        if not player_id or player_id != game.host_player_id:
            emit("error", {"message": "Only the host can return to lobby"}); return
    # Jackbox-style: clear ALL players so everyone rejoins fresh
    # Invalidate all player session tokens
    for p in game.players.values():
        if p.session_token and p.session_token in session_tokens:
            del session_tokens[p.session_token]
    game.reset()
    emit_to_game(game.code, "return_to_lobby", {
        "players": [],
        "settings": {"discussion_time": game.discussion_time, "proposal_time": game.proposal_time},
    })


# --- End game (delete game, send everyone back to join screen) ---

@socketio.on("end_game")
def on_end_game():
    sid = request.sid
    info = sid_to_info.get(sid)
    if not info:
        emit("error", {"message": "Not connected to a game"}); return
    game = games.get(info["game_code"])
    if not game:
        emit("error", {"message": "Game not found"}); return
    # Only host screen or host player can end game
    if not info.get("is_host_screen"):
        player_id = info.get("player_id")
        if not player_id or player_id != game.host_player_id:
            emit("error", {"message": "Only the host can end the game"}); return
    game_code = game.code
    emit_to_game(game_code, "game_ended", {})
    # Clean up
    for pid, player in game.players.items():
        if player.session_token and player.session_token in session_tokens:
            del session_tokens[player.session_token]
    del games[game_code]


# --- Chat ---

@socketio.on("send_chat")
def on_send_chat(data):
    sid = request.sid
    info = sid_to_info.get(sid)
    if not info:
        return
    game = games.get(info.get("game_code"))
    if not game or game.phase == GamePhase.LOBBY:
        return
    player_id = info.get("player_id")
    if not player_id:
        return
    player = game.players.get(player_id)
    if not player:
        return
    msg = str(data.get("message", "")).strip()[:100]
    if not msg:
        return
    emit_to_game(game.code, "chat_message", {
        "name": player.name,
        "message": msg,
    })


# ---------------------------------------------------------------------------
# Debug endpoint
# ---------------------------------------------------------------------------

@app.route("/debug/state/<game_code>")
def debug_state(game_code):
    game = games.get(game_code.upper())
    if not game:
        return {"error": "Not found"}, 404
    return {
        "code": game.code,
        "phase": game.phase,
        "player_count": game.player_count(),
        "players": [
            {"name": p.name, "role": p.role, "team": p.team, "connected": p.connected}
            for p in game.players.values()
        ],
        "player_order": [game.players[pid].name for pid in game.player_order],
        "current_mission": game.current_mission,
        "mission_results": game.mission_results,
        "consecutive_rejections": game.consecutive_rejections,
        "current_leader": game.current_leader().name if game.current_leader() else None,
        "proposed_team": [game.players[pid].name for pid in game.proposed_team if pid in game.players],
        "votes": {game.players[pid].name: v for pid, v in game.votes.items() if pid in game.players},
        "winner": game.winner,
        "win_reason": game.win_reason,
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print("=" * 40)
    print("  AVALON - The Resistance")
    print(f"  Host screen: http://{HOST_IP}:{PORT}/host")
    print(f"  Players join: http://{HOST_IP}:{PORT}")
    print(f"  Dev panel:    http://{HOST_IP}:{PORT}/dev")
    print("=" * 40)
    socketio.run(app, host="0.0.0.0", port=PORT, debug=False, use_reloader=False)
