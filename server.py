import hmac
import logging
import os
import secrets
import threading
import time
import uuid
from collections import defaultdict, deque
from contextlib import nullcontext
from functools import wraps
from urllib.parse import urlsplit

from flask import Flask, abort, jsonify, render_template, request
from flask_socketio import SocketIO, emit, join_room
from werkzeug.middleware.proxy_fix import ProxyFix

from game_logic import (
    GameState,
    GamePhase,
    generate_game_code,
    add_player,
    reorder_players,
    assign_roles,
    get_night_phase_info,
    validate_team_proposal,
    record_vote,
    process_vote_result,
    record_mission_card,
    process_mission_result,
    get_assassin,
    get_assassin_targets,
    process_assassination,
    get_game_summary,
    build_state_snapshot,
    MISSION_SIZES,
    secure_random,
)

APP_ENV = os.environ.get("APP_ENV", "development").lower()
IS_PRODUCTION = APP_ENV == "production"
SECRET_KEY = os.environ.get("SECRET_KEY")
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "").rstrip("/")
PUBLIC_ORIGIN = os.environ.get("PUBLIC_ORIGIN", "").rstrip("/")
ENABLE_DEV_ROUTES = os.environ.get("ENABLE_DEV_ROUTES", "false").lower() == "true"
TRUST_PROXY_HEADERS = os.environ.get("TRUST_PROXY_HEADERS", "false").lower() == "true"
PORT = int(os.environ.get("PORT", 5001))

if IS_PRODUCTION:
    missing = [
        name
        for name, value in (
            ("SECRET_KEY", SECRET_KEY),
            ("PUBLIC_BASE_URL", PUBLIC_BASE_URL),
            ("PUBLIC_ORIGIN", PUBLIC_ORIGIN),
        )
        if not value
    ]
    if missing:
        raise RuntimeError(
            f"Missing required production settings: {', '.join(missing)}"
        )
    if len(SECRET_KEY) < 32:
        raise RuntimeError("SECRET_KEY must be at least 32 characters")
    if SECRET_KEY.startswith("replace-with-"):
        raise RuntimeError("Replace the example production secrets before starting")
    parsed_public_url = urlsplit(PUBLIC_BASE_URL)
    if parsed_public_url.scheme != "https" or not parsed_public_url.netloc:
        raise RuntimeError(
            "PUBLIC_BASE_URL must be an absolute HTTPS URL in production"
        )
    if PUBLIC_ORIGIN != f"{parsed_public_url.scheme}://{parsed_public_url.netloc}":
        raise RuntimeError("PUBLIC_ORIGIN must match the origin of PUBLIC_BASE_URL")

app = Flask(__name__)
app.config.update(
    SECRET_KEY=SECRET_KEY or secrets.token_hex(32),
    SEND_FILE_MAX_AGE_DEFAULT=3600,
    MAX_CONTENT_LENGTH=64 * 1024,
)
if TRUST_PROXY_HEADERS:
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

# None keeps Flask-SocketIO's secure same-origin default for local development.
allowed_origins = [PUBLIC_ORIGIN] if PUBLIC_ORIGIN else None
socketio = SocketIO(
    app,
    async_mode="threading",
    cors_allowed_origins=allowed_origins,
    max_http_buffer_size=64 * 1024,
    ping_interval=25,
    ping_timeout=20,
)
logger = logging.getLogger("avalon")


@app.after_request
def no_cache(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; "
        "script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
        "media-src 'self'; connect-src 'self' ws: wss:; form-action 'self'"
    )
    if request.path.startswith(("/host", "/debug", "/dev")):
        response.headers["Cache-Control"] = "no-store"
    if request.is_secure:
        response.headers["Strict-Transport-Security"] = (
            "max-age=31536000; includeSubDomains"
        )
    return response


# ---------------------------------------------------------------------------
# Global state
# ---------------------------------------------------------------------------
games: dict[str, GameState] = {}  # code -> GameState
game_activity: dict[str, float] = {}  # code -> last activity (monotonic seconds)
sid_to_info: dict[str, dict] = {}  # sid -> {game_code, player_id, is_host_screen}
session_tokens: dict[str, tuple] = {}  # token -> (game_code, player_id)
state_lock = threading.RLock()
rate_lock = threading.Lock()
rate_windows: dict[tuple[str, str], deque] = defaultdict(deque)
connected_sids: set[str] = set()

EVENT_LIMITS = {
    "create_game": (5, 60),
    "register_host": (10, 60),
    "join_game": (15, 60),
    "reconnect_game": (20, 60),
    "chat": (30, 60),
    "default": (120, 60),
}
MAX_CONNECTIONS = int(os.environ.get("MAX_CONNECTIONS", 100))
MAX_GAMES = int(os.environ.get("MAX_GAMES", 50))
MAX_RATE_KEYS = max(100, int(os.environ.get("MAX_RATE_KEYS", 5000)))
GAME_TTL_SECONDS = max(3600, int(os.environ.get("GAME_TTL_SECONDS", 43200)))

# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.route("/")
def player_screen():
    return render_template("player.html")


@app.route("/host")
def host_screen():
    return render_template("host.html")


@app.get("/healthz")
def healthcheck():
    return jsonify(status="ok")


if ENABLE_DEV_ROUTES and not IS_PRODUCTION:

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


def public_base_url() -> str:
    return PUBLIC_BASE_URL or request.host_url.rstrip("/")


def discard_game(game_code: str, *, notify: bool = False) -> None:
    """Remove one game and all of its reconnect/authorization state."""
    with state_lock:
        if notify:
            emit_to_game(game_code, "game_ended", {})
        games.pop(game_code, None)
        game_activity.pop(game_code, None)
        for token, (token_game_code, _) in list(session_tokens.items()):
            if token_game_code == game_code:
                del session_tokens[token]
        for sid, info in list(sid_to_info.items()):
            if info.get("game_code") == game_code:
                del sid_to_info[sid]


def cleanup_stale_games() -> None:
    cutoff = time.monotonic() - GAME_TTL_SECONDS
    with state_lock:
        candidates = [
            (game_code, games.get(game_code))
            for game_code, last_activity in game_activity.items()
            if last_activity <= cutoff
        ]
    for game_code, game in candidates:
        if not game:
            continue
        with game.lock:
            if game_activity.get(game_code, time.monotonic()) <= cutoff:
                discard_game(game_code, notify=True)


def pause(seconds: float) -> None:
    """Socket.IO-compatible sleep, disabled in tests."""
    if not app.config.get("TESTING"):
        socketio.sleep(seconds)


def require_object(data) -> dict:
    if not isinstance(data, dict):
        raise ValueError("Invalid request")
    return data


def require_string(
    data: dict, key: str, *, minimum: int = 1, maximum: int = 256
) -> str:
    value = data.get(key)
    if not isinstance(value, str):
        raise ValueError(f"{key} must be text")
    value = value.strip()
    if not minimum <= len(value) <= maximum:
        raise ValueError(f"{key} must be between {minimum} and {maximum} characters")
    return value


def require_string_list(data: dict, key: str, *, maximum: int = 10) -> list[str]:
    value = data.get(key)
    if not isinstance(value, list) or len(value) > maximum:
        raise ValueError(f"{key} must be a list of at most {maximum} items")
    if not all(isinstance(item, str) and 1 <= len(item) <= 128 for item in value):
        raise ValueError(f"{key} contains an invalid item")
    return value


def require_integer(data: dict, key: str, *, minimum: int, maximum: int) -> int:
    value = data.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{key} must be an integer")
    if not minimum <= value <= maximum:
        raise ValueError(f"{key} must be between {minimum} and {maximum}")
    return value


def event_game_lock(args):
    """Resolve the room touched by an event without trusting its payload."""
    with state_lock:
        info = sid_to_info.get(request.sid)
        game_code = info.get("game_code") if info else None
        data = args[0] if args and isinstance(args[0], dict) else {}
        if not game_code:
            candidate = data.get("game_code") or data.get("room_code")
            if isinstance(candidate, str):
                game_code = candidate.upper()
        if not game_code:
            token = data.get("session_token")
            token_entry = session_tokens.get(token) if isinstance(token, str) else None
            game_code = token_entry[0] if token_entry else None
        game = games.get(game_code)
        return game.lock if game else nullcontext()


def rate_limited(bucket: str = "default"):
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            limit, period = EVENT_LIMITS[bucket]
            now = time.monotonic()
            keys = [(request.sid, bucket, limit)]
            # Fresh sockets must not bypass authentication/join throttles. The
            # multiplier avoids penalizing a normal household behind one NAT.
            if bucket in {
                "create_game",
                "register_host",
                "join_game",
                "reconnect_game",
            }:
                keys.append(
                    (f"ip:{request.remote_addr or 'unknown'}", bucket, limit * 3)
                )
            with rate_lock:
                if len(rate_windows) >= MAX_RATE_KEYS:
                    oldest_allowed = now - max(
                        period for _, period in EVENT_LIMITS.values()
                    )
                    for rate_key, stale_window in list(rate_windows.items()):
                        while stale_window and stale_window[0] <= oldest_allowed:
                            stale_window.popleft()
                        if not stale_window:
                            del rate_windows[rate_key]
                new_keys = sum(
                    (identity, bucket_name) not in rate_windows
                    for identity, bucket_name, _ in keys
                )
                if len(rate_windows) + new_keys > MAX_RATE_KEYS:
                    emit(
                        "error",
                        {"message": "Server is busy. Please try again shortly."},
                    )
                    return None
                windows = []
                for identity, bucket_name, key_limit in keys:
                    window = rate_windows[(identity, bucket_name)]
                    while window and window[0] <= now - period:
                        window.popleft()
                    if len(window) >= key_limit:
                        emit(
                            "error",
                            {
                                "message": "Too many requests. Please wait and try again."
                            },
                        )
                        return None
                    windows.append(window)
                for window in windows:
                    window.append(now)
            # Preserve ordering within one room without blocking other games.
            with event_game_lock(args):
                result = func(*args, **kwargs)
                info = sid_to_info.get(request.sid)
                game_code = info.get("game_code") if info else None
                if game_code in games:
                    game_activity[game_code] = time.monotonic()
                return result

        return wrapper

    return decorator


def validate_host(sid: str, *, require_phase=None):
    info = sid_to_info.get(sid)
    if not info or not info.get("is_host_screen"):
        raise ValueError("Host authorization required")
    game = games.get(info.get("game_code"))
    if not game:
        raise ValueError("Game not found")
    if not game.host_token or not hmac.compare_digest(
        info.get("host_token", ""), game.host_token
    ):
        raise ValueError("Host authorization required")
    if require_phase and game.phase != require_phase:
        raise ValueError(f"Wrong game phase: {game.phase}")
    return game


def emit_validation_error(error: Exception) -> None:
    emit("error", {"message": str(error)})


def lobby_payload(game: GameState) -> dict:
    return {
        "players": game.public_players(),
        "settings": {
            "discussion_time": game.discussion_time,
            "proposal_time": game.proposal_time,
            "beta_test_mode": game.beta_test_mode,
        },
    }


def add_beta_bots(game: GameState, target_count: int = 6) -> None:
    bot_number = 1
    existing_names = {player.name.lower() for player in game.players.values()}
    while game.player_count() < target_count:
        while f"bot {bot_number}" in existing_names:
            bot_number += 1
        name = f"Bot {bot_number}"
        player = add_player(game, name, f"bot-{uuid.uuid4()}")
        player.is_bot = True
        player.sid = None
        existing_names.add(name.lower())
        bot_number += 1


def remove_beta_bots(game: GameState) -> None:
    for player_id, player in list(game.players.items()):
        if player.is_bot:
            game.players.pop(player_id, None)
            if player_id in game.player_order:
                game.player_order.remove(player_id)


def bot_players(game: GameState):
    return [player for player in game.players.values() if player.is_bot]


def validate_caller(
    sid: str, require_phase=None, require_leader=False, require_assassin=False
):
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
        socketio.sleep(1)
        game = games.get(game_code)
        if not game:
            return
        with game.lock:
            if not game or game.timer_phase_key != phase_key:
                return  # cancelled or phase changed
            emit_to_game(game_code, "discussion_tick", {"remaining_seconds": remaining})
    game = games.get(game_code)
    if not game:
        return
    with game.lock:
        if game and game.timer_phase_key == phase_key:
            transition_to_team_proposal(game)


def run_proposal_timer(game_code: str, phase_key: str, duration: int):
    for remaining in range(duration, -1, -1):
        socketio.sleep(1)
        game = games.get(game_code)
        if not game:
            return
        with game.lock:
            if not game or game.timer_phase_key != phase_key:
                return
            emit_to_game(game_code, "proposal_tick", {"remaining_seconds": remaining})
    # Timer expired — just notify host, don't auto-advance (advisory timer)
    game = games.get(game_code)
    if not game:
        return
    with game.lock:
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
    emit_to_game(
        game.code,
        "round_start",
        {
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
            "player_name_to_id": {
                game.players[pid].name: pid for pid in game.player_order
            },
        },
    )
    # Immediately go to discussion
    game.phase = GamePhase.DISCUSSION
    phase_key = str(uuid.uuid4())
    game.timer_phase_key = phase_key
    emit_to_game(
        game.code,
        "discussion_start",
        {
            "duration_seconds": game.discussion_time,
            "mission_num": game.current_mission + 1,
        },
    )
    socketio.start_background_task(
        run_discussion_timer, game.code, phase_key, game.discussion_time
    )


def transition_to_team_proposal(game: GameState):
    game.phase = GamePhase.TEAM_PROPOSAL
    game.proposed_team = []
    game.votes = {}
    game.mission_cards = {}
    leader = game.current_leader()
    phase_key = str(uuid.uuid4())
    game.timer_phase_key = phase_key
    emit_to_game(
        game.code,
        "proposal_start",
        {
            "leader_name": leader.name if leader else "Unknown",
            "leader_id": leader.player_id if leader else None,
            "mission_size": game.mission_size(),
            "player_order": [game.players[pid].name for pid in game.player_order],
            "player_name_to_id": {
                game.players[pid].name: pid for pid in game.player_order
            },
        },
    )
    if leader and leader.is_bot:
        team_ids = secure_random.sample(game.player_order, game.mission_size())
        submit_team_proposal(game, leader, team_ids)


def transition_to_night_phase(game: GameState):
    game.phase = GamePhase.NIGHT_PHASE
    game.night_acks = set()
    emit_to_game(game.code, "night_phase_start", {"total_players": game.player_count()})
    # Send private role info to each player
    for pid, player in game.players.items():
        if player.sid:
            night_info = get_night_phase_info(game, pid)
            emit_to_player(
                player.sid,
                "role_assigned",
                {
                    "role": player.role,
                    "team": player.team,
                    "night_info": night_info,
                },
            )
        elif player.is_bot:
            game.night_acks.add(pid)
    if game.night_acks:
        emit_to_game(
            game.code,
            "night_phase_progress",
            {"confirmed": len(game.night_acks), "total": game.player_count()},
        )


def submit_team_proposal(
    game: GameState, leader, team_ids: list[str]
) -> None:
    validate_team_proposal(game, team_ids)
    game.proposed_team = team_ids
    game.timer_phase_key = None
    game.phase = GamePhase.TEAM_VOTE
    team_names = [game.players[pid].name for pid in team_ids]
    payload = {
        "team": team_names,
        "team_ids": team_ids,
        "leader_name": leader.name,
    }
    emit_to_game(game.code, "team_proposed", payload)
    emit_to_game(game.code, "vote_start", payload)
    for bot in bot_players(game):
        record_vote(game, bot.player_id, secure_random.choice(("approve", "reject")))
    emit_vote_waiting(game)


def emit_vote_waiting(game: GameState) -> None:
    emit_to_game(
        game.code,
        "vote_waiting",
        {
            "voted": [game.players[pid].name for pid in game.votes],
            "remaining": [
                player.name
                for player in game.players.values()
                if player.player_id not in game.votes
            ],
        },
    )


def finish_mission(game: GameState, result: dict) -> None:
    game.phase = GamePhase.MISSION_REVEAL
    emit_to_game(
        game.code,
        "mission_reveal",
        {
            "cards_shuffled": result["cards_shuffled"],
            "fail_count": result["fail_count"],
            "success_count": result["success_count"],
            "passed": result["passed"],
            "mission_num": game.current_mission + 1,
            "requires_double_fail": game.requires_double_fail(),
        },
    )
    pause(4)
    outcome = process_mission_result(game, result["passed"])
    emit_to_game(
        game.code,
        "mission_tracker_update",
        {
            "mission_results": game.mission_results,
            "good_wins": game.good_wins(),
            "evil_wins": game.evil_wins_count(),
        },
    )
    game.pending_mission_outcome = outcome
    emit_to_game(
        game.code,
        "mission_complete",
        {
            "outcome": outcome,
            "passed": result["passed"],
            "good_wins": game.good_wins(),
            "evil_wins": game.evil_wins_count(),
        },
    )


def play_bot_mission_cards(game: GameState) -> None:
    result = None
    for player_id in game.proposed_team:
        player = game.players[player_id]
        if not player.is_bot:
            continue
        card = "success"
        if player.team.value == "evil":
            card = secure_random.choice(("success", "fail"))
        result = record_mission_card(game, player_id, card)
    emit_to_game(
        game.code,
        "mission_waiting",
        {"played": len(game.mission_cards), "total": len(game.proposed_team)},
    )
    if result:
        finish_mission(game, result)


def finish_vote(game: GameState, result: dict) -> None:
    game.phase = GamePhase.VOTE_REVEAL
    emit_to_game(game.code, "vote_reveal", result)
    pause(3)
    outcome = process_vote_result(game, result["approved"])
    if outcome == "mission":
        emit_to_game(
            game.code,
            "mission_start",
            {
                "team": [game.players[pid].name for pid in game.proposed_team],
                "team_ids": game.proposed_team,
                "mission_num": game.current_mission + 1,
            },
        )
        play_bot_mission_cards(game)
    elif outcome == "evil_wins_by_rejection":
        emit_to_game(game.code, "evil_wins_by_rejection", {})
        pause(2)
        emit_to_game(game.code, "game_over", get_game_summary(game))
    else:
        emit_to_game(
            game.code,
            "rejection_warning",
            {
                "consecutive": game.consecutive_rejections,
                "leader_name": (
                    game.current_leader().name if game.current_leader() else "Unknown"
                ),
            },
        )
        pause(2)
        transition_to_team_proposal(game)


def run_bot_assassination(game: GameState) -> None:
    assassin = get_assassin(game)
    if not assassin or not assassin.is_bot:
        return
    targets = get_assassin_targets(game)
    if not targets:
        return
    result = process_assassination(game, secure_random.choice(targets).player_id)
    emit_to_game(game.code, "assassination_result", result)
    pause(3)
    emit_to_game(game.code, "game_over", get_game_summary(game))


# ---------------------------------------------------------------------------
# SocketIO events
# ---------------------------------------------------------------------------


@socketio.on("connect")
def on_connect(auth=None):
    with state_lock:
        if len(connected_sids) >= MAX_CONNECTIONS:
            return False
        connected_sids.add(request.sid)
    return None


@socketio.on("disconnect")
def on_disconnect(reason=None):
    sid = request.sid
    with state_lock:
        connected_sids.discard(sid)
    with rate_lock:
        for key in [key for key in rate_windows if key[0] == sid]:
            del rate_windows[key]
    info = sid_to_info.pop(sid, None)
    if not info:
        return
    game_code = info["game_code"]
    game = games.get(game_code)
    if not game:
        return
    with game.lock:
        if info.get("is_host_screen"):
            game.host_sid = None
            return
        player_id = info.get("player_id")
        if player_id and player_id in game.players:
            game.players[player_id].connected = False
            game.players[player_id].sid = None
            emit_to_game(
                game_code,
                "player_disconnected",
                {
                    "player_id": player_id,
                    "player_name": game.players[player_id].name,
                    "players": game.public_players(),
                },
            )


# --- Host screen registration ---


@socketio.on("register_host_screen")
@rate_limited("register_host")
def on_register_host_screen(data):
    try:
        data = require_object(data)
        game_code = require_string(data, "game_code", minimum=4, maximum=4).upper()
        host_token = require_string(data, "host_token", minimum=32, maximum=128)
        game = games.get(game_code)
        if (
            not game
            or not game.host_token
            or not hmac.compare_digest(host_token, game.host_token)
        ):
            raise ValueError("Game not found or host authorization invalid")
        sid = request.sid
        game.host_sid = sid
        join_room(game_code)
        sid_to_info[sid] = {
            "game_code": game_code,
            "is_host_screen": True,
            "host_token": host_token,
        }
        player_count = game.player_count()
        emit(
            "host_registered",
            {
                "code": game_code,
                "join_url": public_base_url(),
                "players": game.public_players(),
                "phase": game.phase,
                "mission_sizes": MISSION_SIZES.get(player_count, []),
                "mission_results": game.mission_results,
                "current_mission": game.current_mission,
                "consecutive_rejections": game.consecutive_rejections,
                "current_leader": game.current_leader().name
                if game.current_leader()
                else "",
                "discussion_time": game.discussion_time,
                "beta_test_mode": game.beta_test_mode,
                "pending_mission_outcome": game.pending_mission_outcome,
                "proposed_team": [
                    game.players[pid].name
                    for pid in game.proposed_team
                    if pid in game.players
                ],
                "votes": {
                    game.players[pid].name: vote
                    for pid, vote in game.votes.items()
                    if pid in game.players
                },
                "mission_cards_played": len(game.mission_cards),
                "summary": get_game_summary(game)
                if game.phase == GamePhase.GAME_OVER
                else None,
                "assassin_name": (
                    get_assassin(game).name if get_assassin(game) else "Unknown"
                ),
            },
        )
    except ValueError as error:
        emit_validation_error(error)


# --- Create game (host screen initiates) ---


@socketio.on("create_game")
@rate_limited("create_game")
def on_create_game(data=None):
    try:
        cleanup_stale_games()
        with state_lock:
            sid = request.sid
            existing_info = sid_to_info.get(sid)
            existing_game = (
                games.get(existing_info.get("game_code"))
                if existing_info and existing_info.get("is_host_screen")
                else None
            )
            if existing_game:
                emit(
                    "game_created",
                    {
                        "room_code": existing_game.code,
                        "host_token": existing_game.host_token,
                        "join_url": public_base_url(),
                    },
                )
                return
            if len(games) >= MAX_GAMES:
                raise ValueError("The server has reached its active-game limit")
            code = generate_game_code(set(games.keys()))
            game = GameState(code)
            game.host_token = secrets.token_urlsafe(32)
            games[code] = game
            game_activity[code] = time.monotonic()
            game.host_sid = sid
            join_room(code)
            sid_to_info[sid] = {
                "game_code": code,
                "is_host_screen": True,
                "host_token": game.host_token,
            }
        emit(
            "game_created",
            {
                "room_code": code,
                "host_token": game.host_token,
                "join_url": public_base_url(),
            },
        )
    except ValueError as error:
        emit_validation_error(error)


# --- Player joins ---


@socketio.on("join_game")
@rate_limited("join_game")
def on_join_game(data):
    try:
        data = require_object(data)
        code = require_string(data, "room_code", minimum=4, maximum=4).upper()
        name = require_string(data, "player_name", minimum=1, maximum=12)
        game = games.get(code)
        if not game:
            raise ValueError("Room not found. Check the code and try again.")
        sid = request.sid
        player_id = str(uuid.uuid4())
        player = add_player(game, name, player_id)
        token = secrets.token_urlsafe(32)
        player.session_token = token
        player.sid = sid
        session_tokens[token] = (code, player_id)
        join_room(code)
        sid_to_info[sid] = {"game_code": code, "player_id": player_id}
        emit(
            "join_success",
            {
                "player_id": player_id,
                "session_token": token,
                "player_name": player.name,
                "is_host": False,
                "room_code": code,
                "players": game.public_players(),
                "settings": {
                    "discussion_time": game.discussion_time,
                    "proposal_time": game.proposal_time,
                    "beta_test_mode": game.beta_test_mode,
                },
            },
        )
        emit_to_game(
            code,
            "player_joined",
            {
                "new_player": player.name,
                "players": game.public_players(),
                "player_count": game.player_count(),
            },
        )
    except ValueError as error:
        emit_validation_error(error)


# --- Reconnect ---


@socketio.on("reconnect_game")
@rate_limited("reconnect_game")
def on_reconnect_game(data):
    try:
        data = require_object(data)
        token = require_string(data, "session_token", minimum=32, maximum=128)
        entry = session_tokens.get(token)
        if not entry:
            raise ValueError("Session not found. Please rejoin.")
        game_code, player_id = entry
        game = games.get(game_code)
        if not game:
            raise ValueError("Game no longer exists.")
        player = game.players.get(player_id)
        if not player:
            raise ValueError("Player not found in game.")
        sid = request.sid
        old_sid = player.sid
        if old_sid and old_sid in sid_to_info:
            del sid_to_info[old_sid]
        player.sid = sid
        player.connected = True
        join_room(game_code)
        sid_to_info[sid] = {"game_code": game_code, "player_id": player_id}
        snapshot = build_state_snapshot(game, player_id)
        emit("state_snapshot", snapshot)
        emit_to_game(
            game_code,
            "player_reconnected",
            {
                "player_id": player_id,
                "player_name": player.name,
                "players": game.public_players(),
            },
        )
    except ValueError as error:
        emit_validation_error(error)


# --- Lobby management ---


@socketio.on("reorder_players")
@rate_limited()
def on_reorder_players(data):
    try:
        game = validate_host(request.sid, require_phase=GamePhase.LOBBY)
        data = require_object(data)
        ordered_names = require_string_list(data, "order")
        reorder_players(game, ordered_names)
        emit_to_game(
            game.code,
            "lobby_update",
            lobby_payload(game),
        )
    except ValueError as error:
        emit_validation_error(error)


@socketio.on("update_settings")
@rate_limited()
def on_update_settings(data):
    try:
        game = validate_host(request.sid, require_phase=GamePhase.LOBBY)
        data = require_object(data)
        if "discussion_time" in data:
            game.discussion_time = require_integer(
                data, "discussion_time", minimum=10, maximum=600
            )
        if "proposal_time" in data:
            game.proposal_time = require_integer(
                data, "proposal_time", minimum=30, maximum=120
            )
        emit_to_game(
            game.code,
            "lobby_update",
            lobby_payload(game),
        )
    except ValueError as error:
        emit_validation_error(error)


@socketio.on("set_beta_test_mode")
@rate_limited()
def on_set_beta_test_mode(data):
    try:
        game = validate_host(request.sid, require_phase=GamePhase.LOBBY)
        data = require_object(data)
        enabled = data.get("enabled")
        if not isinstance(enabled, bool):
            raise ValueError("enabled must be true or false")
        game.beta_test_mode = enabled
        if enabled:
            add_beta_bots(game)
        else:
            remove_beta_bots(game)
        emit_to_game(game.code, "lobby_update", lobby_payload(game))
    except ValueError as error:
        emit_validation_error(error)


@socketio.on("preview_team")
@rate_limited()
def on_preview_team(data):
    """Leader broadcasts their in-progress team selection to host screen."""
    sid = request.sid
    try:
        game, player = validate_caller(
            sid, require_phase=GamePhase.TEAM_PROPOSAL, require_leader=True
        )
        data = require_object(data)
        names = require_string_list(data, "team_names")
        valid_names = {p.name for p in game.players.values()}
        if (
            len(names) > game.mission_size()
            or len(set(names)) != len(names)
            or not set(names) <= valid_names
        ):
            raise ValueError("Invalid team preview")
        emit_to_game(game.code, "team_preview", {"team_names": names})
    except ValueError as error:
        emit_validation_error(error)


@socketio.on("start_game")
@rate_limited()
def on_start_game():
    try:
        game = validate_host(request.sid, require_phase=GamePhase.LOBBY)
        n = game.player_count()
        if game.beta_test_mode and not any(
            not player.is_bot for player in game.players.values()
        ):
            raise ValueError("Join with at least one real player before testing.")
        if n < 6 or n > 10:
            raise ValueError(f"Need 6-10 players. Currently {n}.")
        assign_roles(game)
        emit_to_game(game.code, "game_starting", {"player_count": n})
        pause(1)
        transition_to_night_phase(game)
    except ValueError as error:
        emit_validation_error(error)


# --- Night phase ---


@socketio.on("night_phase_ack")
@rate_limited()
def on_night_phase_ack():
    sid = request.sid
    try:
        game, player = validate_caller(sid, require_phase=GamePhase.NIGHT_PHASE)
    except ValueError as e:
        emit("error", {"message": str(e)})
        return
    if player.player_id in game.night_acks:
        return  # Already acked, ignore duplicate
    game.night_acks.add(player.player_id)
    confirmed = len(game.night_acks)
    total = game.player_count()
    emit_to_game(
        game.code,
        "night_phase_progress",
        {
            "confirmed": confirmed,
            "total": total,
        },
    )
    if confirmed >= total:
        game.phase = GamePhase.ROUND_START  # Prevent re-entry
        emit_to_game(game.code, "night_phase_complete", {})
        pause(1)
        start_round(game)


# --- Discussion ---


@socketio.on("skip_discussion")
@rate_limited()
def on_skip_discussion(data):
    try:
        require_object(data)
        game = validate_host(request.sid, require_phase=GamePhase.DISCUSSION)
        game.timer_phase_key = None
        emit_to_game(game.code, "discussion_end", {})
        transition_to_team_proposal(game)
    except ValueError as error:
        emit_validation_error(error)


# --- Team proposal ---


@socketio.on("propose_team")
@rate_limited()
def on_propose_team(data):
    sid = request.sid
    try:
        game, player = validate_caller(
            sid, require_phase=GamePhase.TEAM_PROPOSAL, require_leader=True
        )
    except ValueError as e:
        emit("error", {"message": str(e)})
        return
    try:
        data = require_object(data)
        team_ids = require_string_list(data, "team")
        validate_team_proposal(game, team_ids)
    except ValueError as e:
        emit("error", {"message": str(e)})
        return
    submit_team_proposal(game, player, team_ids)


@socketio.on("skip_proposal_timer")
@rate_limited()
def on_skip_proposal_timer():
    try:
        game = validate_host(request.sid, require_phase=GamePhase.TEAM_PROPOSAL)
        game.timer_phase_key = None
        emit_to_game(game.code, "proposal_timer_expired", {})
    except ValueError as error:
        emit_validation_error(error)


# --- Voting ---


@socketio.on("cast_vote")
@rate_limited()
def on_cast_vote(data):
    sid = request.sid
    try:
        game, player = validate_caller(sid, require_phase=GamePhase.TEAM_VOTE)
    except ValueError as e:
        emit("error", {"message": str(e)})
        return
    try:
        data = require_object(data)
        vote = require_string(data, "vote", minimum=6, maximum=7)
        result = record_vote(game, player.player_id, vote)
    except ValueError as e:
        emit("error", {"message": str(e)})
        return
    emit("vote_cast_ack", {}, room=sid)
    emit_vote_waiting(game)
    if result:
        finish_vote(game, result)


# --- Mission ---


@socketio.on("play_mission_card")
@rate_limited()
def on_play_mission_card(data):
    sid = request.sid
    try:
        game, player = validate_caller(sid, require_phase=GamePhase.MISSION)
    except ValueError as e:
        emit("error", {"message": str(e)})
        return
    try:
        data = require_object(data)
        card = require_string(data, "card", minimum=4, maximum=7)
        result = record_mission_card(game, player.player_id, card)
    except ValueError as e:
        emit("error", {"message": str(e)})
        return
    emit("mission_card_ack", {}, room=sid)
    played = len(game.mission_cards)
    total = len(game.proposed_team)
    emit_to_game(game.code, "mission_waiting", {"played": played, "total": total})
    if result:
        finish_mission(game, result)


# --- Advance after mission (host clicks "Next Round") ---


@socketio.on("advance_after_mission")
@rate_limited()
def on_advance_after_mission():
    try:
        game = validate_host(request.sid)
        outcome = game.pending_mission_outcome
        if not outcome:
            raise ValueError("No completed mission is awaiting advancement")
        game.pending_mission_outcome = None
        if outcome == "assassin_phase":
            game.phase = GamePhase.ASSASSIN_PHASE
            assassin = get_assassin(game)
            emit_to_game(
                game.code,
                "assassin_phase_start",
                {
                    "assassin_name": assassin.name if assassin else "Unknown",
                    "assassin_id": assassin.player_id if assassin else None,
                    "targets": [
                        {"name": p.name, "player_id": p.player_id}
                        for p in get_assassin_targets(game)
                    ],
                },
            )
            run_bot_assassination(game)
        elif outcome == "evil_wins":
            game.phase = GamePhase.GAME_OVER
            emit_to_game(game.code, "game_over", get_game_summary(game))
        else:
            game.current_mission += 1
            game.consecutive_rejections = 0
            game.current_leader_index = (game.current_leader_index + 1) % len(
                game.player_order
            )
            game.proposed_team = []
            game.votes = {}
            game.mission_cards = {}
            start_round(game)
    except ValueError as error:
        emit_validation_error(error)


# --- Assassination ---


@socketio.on("assassinate")
@rate_limited()
def on_assassinate(data):
    sid = request.sid
    try:
        game, player = validate_caller(
            sid, require_phase=GamePhase.ASSASSIN_PHASE, require_assassin=True
        )
    except ValueError as e:
        emit("error", {"message": str(e)})
        return
    try:
        data = require_object(data)
        target_id = require_string(data, "target_player_id", minimum=32, maximum=64)
        result = process_assassination(game, target_id)
    except ValueError as e:
        emit("error", {"message": str(e)})
        return
    emit_to_game(game.code, "assassination_result", result)
    pause(3)
    emit_to_game(game.code, "game_over", get_game_summary(game))


# --- Return to lobby ---


@socketio.on("return_to_lobby")
@rate_limited()
def on_return_to_lobby():
    try:
        game = validate_host(request.sid)
        game.reset()
        emit_to_game(
            game.code,
            "return_to_lobby",
            {
                "players": game.public_players(),
                "settings": {
                    "discussion_time": game.discussion_time,
                    "proposal_time": game.proposal_time,
                    "beta_test_mode": game.beta_test_mode,
                },
            },
        )
    except ValueError as error:
        emit_validation_error(error)


# --- End game (delete game, send everyone back to join screen) ---


@socketio.on("end_game")
@rate_limited()
def on_end_game():
    try:
        game = validate_host(request.sid)
        game_code = game.code
        discard_game(game_code, notify=True)
    except ValueError as error:
        emit_validation_error(error)


# --- Chat ---


@socketio.on("send_chat")
@rate_limited("chat")
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
    try:
        data = require_object(data)
        msg = require_string(data, "message", minimum=1, maximum=100)
    except ValueError as error:
        emit_validation_error(error)
        return
    emit_to_game(
        game.code,
        "chat_message",
        {
            "name": player.name,
            "message": msg,
        },
    )


# ---------------------------------------------------------------------------
# Development-only debug endpoint
# ---------------------------------------------------------------------------

if ENABLE_DEV_ROUTES and not IS_PRODUCTION:

    @app.route("/debug/state/<game_code>")
    def debug_state(game_code):
        game = games.get(game_code.upper())
        if not game:
            abort(404)
        return {
            "code": game.code,
            "phase": game.phase,
            "player_count": game.player_count(),
            "players": [
                {
                    "name": p.name,
                    "role": p.role,
                    "team": p.team,
                    "connected": p.connected,
                }
                for p in game.players.values()
            ],
        }


@socketio.on_error_default
def handle_socket_error(error):
    logger.exception("Unhandled Socket.IO error")
    emit("error", {"message": "Invalid request"})


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print("=" * 40)
    print("  AVALON - The Resistance")
    print(f"  Host screen: http://127.0.0.1:{PORT}/host")
    print(f"  Players join: http://127.0.0.1:{PORT}")
    print("=" * 40)
    socketio.run(app, host="127.0.0.1", port=PORT, debug=False, use_reloader=False)
