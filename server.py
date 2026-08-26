import base64
import binascii
import hmac
import hashlib
import io
import json
import logging
import math
import os
import secrets
import threading
import time
import uuid
from collections import defaultdict, deque
from contextlib import nullcontext
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path
from urllib.parse import urlsplit

import segno
from flask import Flask, Response, abort, jsonify, render_template, request
from flask_socketio import SocketIO, emit, join_room
from werkzeug.middleware.proxy_fix import ProxyFix

from chat_store import configured_chat_store
from selfie_archive import SelfieArchive
from research_telemetry import (
    RESEARCH_SPEC_VERSION,
    RULESET_VERSION,
    classify_event,
    pseudonymous_subject_id,
    replay_state,
    scalar,
    utc_timestamp,
)
from game_logic import (
    GameState,
    GamePhase,
    PlayerInfo,
    Role,
    Team,
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
    spectrum_average_positions,
    role_manifest,
    SpectatorInfo,
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
APP_VERSION = os.environ.get("APP_VERSION", "development")[:64]
ANALYTICS_SCHEMA_VERSION = 1
RESEARCH_TELEMETRY_ENABLED = (
    os.environ.get("RESEARCH_TELEMETRY_ENABLED", "true").lower() == "true"
)
RESEARCH_CHECKPOINTS_ENABLED = (
    os.environ.get("RESEARCH_CHECKPOINTS_ENABLED", "true").lower() == "true"
)
ANALYTICS_PSEUDONYM_KEY = (
    os.environ.get("ANALYTICS_PSEUDONYM_KEY")
    or SECRET_KEY
    or "avalon-development-research-subjects"
)

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
    configured_pseudonym_key = os.environ.get("ANALYTICS_PSEUDONYM_KEY")
    if configured_pseudonym_key and (
        len(configured_pseudonym_key) < 32
        or configured_pseudonym_key.startswith("replace-with-")
    ):
        raise RuntimeError(
            "ANALYTICS_PSEUDONYM_KEY must be a non-example secret of at least 32 characters"
        )
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
    MAX_CONTENT_LENGTH=256 * 1024,
)
if TRUST_PROXY_HEADERS:
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

# None keeps Flask-SocketIO's secure same-origin default for local development.
allowed_origins = [PUBLIC_ORIGIN] if PUBLIC_ORIGIN else None
socketio = SocketIO(
    app,
    async_mode="threading",
    cors_allowed_origins=allowed_origins,
    max_http_buffer_size=256 * 1024,
    ping_interval=25,
    ping_timeout=20,
)
logger = logging.getLogger("avalon")
chat_store = configured_chat_store()
chat_store.initialize()
SELFIE_ARCHIVE_DIR = Path(
    os.environ.get(
        "SELFIE_ARCHIVE_DIR", str(chat_store.path.parent / "private" / "selfies")
    )
)
static_root = Path(app.static_folder).resolve()
resolved_selfie_archive = SELFIE_ARCHIVE_DIR.resolve()
if (
    resolved_selfie_archive == static_root
    or static_root in resolved_selfie_archive.parents
):
    raise RuntimeError("SELFIE_ARCHIVE_DIR must be outside the public static directory")
selfie_archive = SelfieArchive(str(SELFIE_ARCHIVE_DIR))
chat_persistence_error_logged = False
game_persistence_error_logged = False
room_persistence_error_logged = False
selfie_persistence_error_logged = False
analytics_persistence_error_logged = False
research_persistence_error_logged = False


@app.after_request
def apply_response_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; "
        "script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
        "media-src 'self'; connect-src 'self' ws: wss:; form-action 'self'"
    )
    # The HTML shell must always be revalidated so a deployment cannot strand
    # returning players on stale JavaScript URLs. Versioned static resources,
    # including the large cinematic artwork, are safe to retain for a year.
    if response.mimetype == "text/html" or request.path.startswith("/debug"):
        response.headers["Cache-Control"] = "no-store"
    elif request.path.startswith("/static/") and request.args.get("v"):
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
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
session_tokens: dict[str, tuple] = {}  # SHA-256(token) -> (game_code, player_id)
spectator_tokens: dict[str, tuple[str, str]] = {}
state_lock = threading.RLock()
rate_lock = threading.Lock()
rate_windows: dict[tuple[str, str], deque] = defaultdict(deque)
connected_sids: set[str] = set()
sid_to_ip: dict[str, str] = {}

EVENT_LIMITS = {
    "create_game": (5, 60),
    "register_host": (10, 60),
    "join_game": (15, 60),
    "reconnect_game": (20, 60),
    "claim_seat": (10, 60),
    "pair_display": (10, 60),
    "chat": (30, 60),
    "analytics": (120, 60),
    "default": (120, 60),
}
MAX_CONNECTIONS = int(os.environ.get("MAX_CONNECTIONS", 100))
MAX_CONNECTIONS_PER_IP = int(os.environ.get("MAX_CONNECTIONS_PER_IP", 30))
MAX_GAMES = int(os.environ.get("MAX_GAMES", 50))
MAX_RATE_KEYS = max(100, int(os.environ.get("MAX_RATE_KEYS", 5000)))
GAME_TTL_SECONDS = max(1 if APP_ENV == "test" else 3600, int(os.environ.get("GAME_TTL_SECONDS", 86400)))
ROOM_SCHEMA_VERSION = 1

# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.route("/")
def player_screen():
    return render_template("player.html", force_new=False)


@app.route("/new")
def new_game_screen():
    return render_template("player.html", force_new=True)


@app.route("/host")
def host_screen():
    return render_template("host.html")


@app.get("/healthz")
def healthcheck():
    return jsonify(status="ok")


@app.get("/join-qr.svg")
def join_qr():
    cleanup_stale_games()
    code = (request.args.get("room") or "").strip().upper()
    if len(code) != 4 or code not in games:
        abort(404)
    qr = segno.make(f"{public_base_url()}/?room={code}", error="m")
    output = io.BytesIO()
    qr.save(
        output,
        kind="svg",
        scale=5,
        border=2,
        dark="#1a1508",
        light="#f1e8cf",
    )
    return Response(
        output.getvalue(),
        mimetype="image/svg+xml",
        headers={"Cache-Control": "no-store"},
    )


if ENABLE_DEV_ROUTES and not IS_PRODUCTION:

    @app.route("/dev")
    def dev_screen():
        return render_template("dev.html")

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def emit_to_game(game_code: str, event: str, data: dict):
    socketio.emit(event, data, room=game_code)


def research_subject_id(analytics_id: str | None) -> str | None:
    return pseudonymous_subject_id(analytics_id, ANALYTICS_PSEUDONYM_KEY)


def _research_elapsed(game: GameState | None) -> tuple[int | None, int | None]:
    if not game:
        return None, None
    now = time.time()
    game_elapsed_ms = None
    if game.started_at is not None:
        active_seconds = float(game.active_elapsed_seconds)
        if game.active_since is not None:
            active_seconds += max(0.0, now - game.active_since)
        game_elapsed_ms = max(0, round(active_seconds * 1000))
    phase_elapsed_ms = max(0, round((now - game.phase_started_at) * 1000))
    return game_elapsed_ms, phase_elapsed_ms


def research_participant_record(
    game: GameState, participant_id: str, *, at: float | None = None
) -> dict | None:
    """Return one normalized player/spectator dimension row."""
    if not game.game_id:
        return None
    timestamp = datetime.fromtimestamp(at or time.time(), timezone.utc)
    timestamp_text = utc_timestamp(timestamp)
    player = game.players.get(participant_id)
    if player:
        seat_index = (
            game.player_order.index(participant_id)
            if participant_id in game.player_order
            else None
        )
        team = scalar(player.team)
        won = None if not game.winner or not team else team == game.winner
        return {
            "game_id": game.game_id,
            "participant_id": player.player_id,
            "participant_type": "player",
            "subject_id": research_subject_id(player.analytics_id),
            "display_name": player.name,
            "seat_index": seat_index,
            "role": scalar(player.role),
            "team": team,
            "is_bot": player.is_bot,
            "is_host_player": player.player_id == game.host_player_id,
            "color_index": player.color_index,
            "avatar_index": player.avatar_index,
            "avatar_source": "selfie" if player.selfie_sha256 else "built_in",
            "selfie_sha256": player.selfie_sha256,
            "vision_mode": None,
            "first_seen_at": utc_timestamp(
                datetime.fromtimestamp(game.started_at or (at or time.time()), timezone.utc)
            ),
            "last_seen_at": timestamp_text,
            "won": won,
        }
    spectator = game.spectators.get(participant_id)
    if spectator:
        return {
            "game_id": game.game_id,
            "participant_id": spectator.spectator_id,
            "participant_type": "spectator",
            "subject_id": research_subject_id(spectator.analytics_id),
            "display_name": spectator.name,
            "seat_index": None,
            "role": None,
            "team": None,
            "is_bot": False,
            "is_host_player": False,
            "color_index": spectator.color_index,
            "avatar_index": None,
            "avatar_source": None,
            "selfie_sha256": None,
            "vision_mode": spectator.vision_mode,
            "first_seen_at": timestamp_text,
            "last_seen_at": timestamp_text,
            "won": None,
        }
    return None


def research_participant_records(
    game: GameState, *, at: float | None = None
) -> list[dict]:
    records = [
        research_participant_record(game, participant_id, at=at)
        for participant_id in [*game.player_order, *sorted(game.spectators)]
    ]
    return [record for record in records if record]


def record_research_event(
    event_type: str,
    *,
    game: GameState | None = None,
    source: str = "server",
    category: str | None = None,
    visibility: str = "private",
    actor_type: str = "system",
    actor_id: str | None = None,
    analytics_id: str | None = None,
    payload: dict | None = None,
    state: dict | None = None,
    event_id: str | None = None,
    client: dict | None = None,
) -> None:
    """Append to the canonical stream without ever interrupting a live game."""
    global research_persistence_error_logged
    if not RESEARCH_TELEMETRY_ENABLED:
        return
    client = client or {}
    if game and game.game_id:
        stream_id = game.game_id
        stream_type = "game"
    elif game:
        stream_id = game.party_id
        stream_type = "party"
    elif client.get("session_id"):
        stream_id = client["session_id"]
        stream_type = "client"
    else:
        return
    try:
        game_elapsed_ms, phase_elapsed_ms = _research_elapsed(game)
        chat_store.save_research_event(
            stream_id=stream_id,
            stream_type=stream_type,
            app_version=APP_VERSION,
            event_type=event_type,
            source=source,
            category=category or classify_event(event_type, source),
            visibility=visibility,
            actor_type=actor_type,
            actor_id=actor_id,
            subject_id=research_subject_id(analytics_id),
            party_id=game.party_id if game else None,
            room_code=game.code if game else None,
            game_id=game.game_id if game else None,
            phase=scalar(game.phase) if game else None,
            mission_num=(game.current_mission + 1) if game and game.started_at else None,
            proposal_attempt=(
                game.consecutive_rejections + 1 if game and game.started_at else None
            ),
            game_elapsed_ms=game_elapsed_ms,
            phase_elapsed_ms=phase_elapsed_ms,
            payload=payload or {},
            state=state,
            event_id=event_id,
            client=client,
        )
        research_persistence_error_logged = False
    except Exception:
        if not research_persistence_error_logged:
            logger.exception("Could not persist canonical research telemetry")
            research_persistence_error_logged = True
        return
    if (
        game
        and game.game_id
        and actor_id
        and event_type
        in {
            "player_joined",
            "player_reconnected",
            "spectator_joined",
            "spectator_reconnected",
            "seat_recovered",
            "client_session_started",
        }
    ):
        participant = research_participant_record(game, actor_id)
        if participant:
            try:
                chat_store.upsert_research_participant(participant)
            except Exception:
                if not research_persistence_error_logged:
                    logger.exception("Could not update research participant")
                    research_persistence_error_logged = True


def start_research_game(
    game: GameState, *, initial_state_source: str = "game_start"
) -> bool:
    global research_persistence_error_logged
    if not RESEARCH_TELEMETRY_ENABLED or not game.game_id or not game.started_at:
        return False
    try:
        initial_state = replay_state(game, captured_at=game.started_at)
        chat_store.start_research_game(
            game={
                "game_id": game.game_id,
                "party_id": game.party_id,
                "room_code": game.code,
                "ruleset_version": RULESET_VERSION,
                "app_version": APP_VERSION,
                "started_at": utc_timestamp(
                    datetime.fromtimestamp(game.started_at, timezone.utc)
                ),
                "started_at_unix": game.started_at,
                "player_count": game.player_count(),
                "human_count": sum(
                    not player.is_bot for player in game.players.values()
                ),
                "spectator_count": len(game.spectators),
                "settings": {
                    "discussion_seconds": game.discussion_time,
                    "proposal_seconds": game.proposal_time,
                    "beta_test_mode": game.beta_test_mode,
                    "beta_test_player_count": game.beta_test_player_count,
                    "initial_state_source": initial_state_source,
                },
                "role_set": [
                    {"role": scalar(player.role), "team": scalar(player.team)}
                    for player in game.player_order_list()
                ],
                "initial_state": initial_state,
            },
            participants=research_participant_records(game, at=game.started_at),
        )
        research_persistence_error_logged = False
        return True
    except Exception:
        if not research_persistence_error_logged:
            logger.exception("Could not initialize normalized research game")
            research_persistence_error_logged = True
        return False


def backfill_restored_research_game(game: GameState) -> None:
    """Give pre-telemetry persisted games the normalized parent they lack."""
    global research_persistence_error_logged
    if not RESEARCH_TELEMETRY_ENABLED or not game.game_id or not game.started_at:
        return
    try:
        if chat_store.research_game(game.game_id) is not None:
            return
    except Exception:
        if not research_persistence_error_logged:
            logger.exception("Could not inspect restored research game")
            research_persistence_error_logged = True
        return
    if not start_research_game(
        game, initial_state_source="first_available_restored_snapshot"
    ):
        return
    record_research_event(
        "research_game_backfilled",
        game=game,
        source="migration",
        category="lifecycle",
        visibility="research_secret",
        payload={
            "source": "durable_room_snapshot",
            "initial_state_source": "first_available_restored_snapshot",
        },
    )
    record_state_checkpoint(game, reason="restored_game_backfill")


def finalize_research_game(
    game: GameState, *, status: str, abandonment_reason: str | None = None
) -> None:
    global research_persistence_error_logged
    if not RESEARCH_TELEMETRY_ENABLED or not game.game_id or not game.started_at:
        return
    ended_at = time.time()
    active_seconds = float(game.active_elapsed_seconds)
    if game.active_since is not None:
        active_seconds += max(0.0, ended_at - game.active_since)
    try:
        final_state = replay_state(game, captured_at=ended_at)
        chat_store.finalize_research_game(
            game={
                "game_id": game.game_id,
                "status": status,
                "ended_at": utc_timestamp(
                    datetime.fromtimestamp(ended_at, timezone.utc)
                ),
                "ended_at_unix": ended_at,
                "winner": game.winner,
                "win_reason": game.win_reason,
                "wall_duration_ms": max(0, round((ended_at - game.started_at) * 1000)),
                "active_duration_ms": max(0, round(active_seconds * 1000)),
                "mission_count": len(game.mission_results),
                "proposal_count": len(game.proposal_history),
                "successful_missions": game.good_wins(),
                "failed_missions": game.evil_wins_count(),
                "assassination_target_player_id": game.assassin_target,
                "final_state": final_state,
                "abandonment_reason": abandonment_reason,
            },
            participants=research_participant_records(game, at=ended_at),
        )
        research_persistence_error_logged = False
    except Exception:
        if not research_persistence_error_logged:
            logger.exception("Could not finalize normalized research game")
            research_persistence_error_logged = True


def record_state_checkpoint(game: GameState, *, reason: str) -> None:
    if not RESEARCH_CHECKPOINTS_ENABLED or not game.game_id:
        return
    try:
        state = replay_state(game)
    except Exception:
        logger.exception("Could not build replay checkpoint")
        return
    record_research_event(
        "state_checkpoint",
        game=game,
        source="state_checkpoint",
        category="state",
        visibility="research_secret",
        payload={"reason": reason},
        state=state,
    )


def log_game_event(game: GameState, event_type: str, payload: dict) -> None:
    global game_persistence_error_logged
    if not game.started_at:
        return
    try:
        chat_store.save_game_event(
            room_code=game.code,
            game_started_at=game.started_at,
            event_type=event_type,
            payload=payload,
        )
        game_persistence_error_logged = False
    except Exception:
        if not game_persistence_error_logged:
            logger.exception("Could not persist game event")
            game_persistence_error_logged = True
    record_research_event(
        event_type,
        game=game,
        source="gameplay",
        category="gameplay",
        visibility="research_secret",
        payload=payload,
    )


def historical_game_summary(game: GameState) -> dict:
    """History keeps selfie references while the live victory UI keeps images."""
    summary = get_game_summary(game)
    for item, player in zip(summary.get("players", []), game.player_order_list()):
        item.pop("avatar_image", None)
        if player.selfie_sha256:
            item["selfie_sha256"] = player.selfie_sha256
    return summary


def log_completed_game(game: GameState) -> None:
    """Write compact history, terminal telemetry, and normalized outcome facts."""
    log_game_event(game, "game_over", historical_game_summary(game))
    record_product_event(
        "game_completed",
        game=game,
        payload={
            "winner": game.winner or "unknown",
            "win_reason": game.win_reason or "unknown",
            "mission_count": len(game.mission_results),
            "duration_seconds": max(
                0, int(time.time() - game.started_at) if game.started_at else 0
            ),
        },
    )
    record_state_checkpoint(game, reason="game_completed")
    finalize_research_game(game, status="completed")


def record_product_event(
    event_type: str,
    *,
    game: GameState | None = None,
    actor_type: str = "system",
    actor_id: str | None = None,
    analytics_id: str | None = None,
    payload: dict | None = None,
    event_id: str | None = None,
    client: dict | None = None,
    visibility: str = "private",
) -> None:
    """Persist one privacy-bounded analytics fact; never interrupt gameplay."""
    global analytics_persistence_error_logged
    event_id = event_id or str(uuid.uuid4())
    try:
        phase = game.phase.value if game else None
        chat_store.save_product_event(
            event_id=event_id,
            schema_version=ANALYTICS_SCHEMA_VERSION,
            app_version=APP_VERSION,
            party_id=game.party_id if game else None,
            room_code=game.code if game else None,
            game_id=game.game_id if game else None,
            game_started_at=game.started_at if game else None,
            actor_type=actor_type,
            actor_id=actor_id,
            analytics_id=analytics_id,
            event_type=event_type,
            phase=phase,
            mission_num=(game.current_mission + 1) if game and game.started_at else None,
            proposal_attempt=(game.consecutive_rejections + 1) if game and game.started_at else None,
            payload=payload or {},
        )
        analytics_persistence_error_logged = False
    except Exception:
        if not analytics_persistence_error_logged:
            logger.exception("Could not persist product analytics")
            analytics_persistence_error_logged = True
    record_research_event(
        event_type,
        game=game,
        source="client" if client else "product",
        visibility=visibility,
        actor_type=actor_type,
        actor_id=actor_id,
        analytics_id=analytics_id,
        payload=payload,
        event_id=event_id,
        client=client,
    )


def mark_phase_started(game: GameState, event_type: str, payload: dict | None = None) -> None:
    game.phase_started_at = time.time()
    record_product_event(event_type, game=game, payload=payload)


def valid_analytics_id(value) -> str | None:
    """Accept only a resettable UUID supplied by the browser."""
    if not isinstance(value, str):
        return None
    try:
        return str(uuid.UUID(value))
    except (ValueError, AttributeError):
        return None


def recent_chat_payload(game: GameState, limit: int = 30) -> list[dict]:
    """Return a small player-safe chat tail for reconnecting clients."""
    try:
        colors = {player.name: player.color_index for player in game.players.values()}
        colors.update(
            {
                spectator.name: spectator.color_index
                for spectator in game.spectators.values()
            }
        )
        spectator_names = {spectator.name for spectator in game.spectators.values()}
        return [
            {
                "timestamp": row["created_at"],
                "name": row["player_name"],
                "message": row["message"],
                "color_index": colors.get(row["player_name"], 0),
                **(
                    {"is_spectator": True}
                    if row["player_name"] in spectator_names
                    else {}
                ),
            }
            for row in chat_store.recent_messages_for_game(
                game.code, game.started_at, limit=limit
            )
        ]
    except Exception:
        logger.exception("Could not restore recent game chat")
        return []


def emit_to_player(sid: str, event: str, data: dict):
    socketio.emit(event, data, room=sid)


def get_game(game_code: str) -> GameState | None:
    return games.get(game_code)


def get_caller_info(sid: str) -> dict | None:
    return sid_to_info.get(sid)


def public_base_url() -> str:
    return PUBLIC_BASE_URL or request.host_url.rstrip("/")


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def serialize_game(game: GameState) -> dict:
    """Return the durable, JSON-safe portion of a room's authoritative state."""
    now = time.time()
    timer_remaining = game.timer_remaining
    if not game.suspended and game.timer_deadline:
        timer_remaining = max(0, math.ceil(game.timer_deadline - now))
    active_elapsed = game.active_elapsed_seconds
    if game.active_since:
        active_elapsed += max(0, now - game.active_since)
    return {
        "code": game.code,
        "party_id": game.party_id,
        "game_id": game.game_id,
        "phase": game.phase.value,
        "phase_started_at": game.phase_started_at,
        "players": [
            {
                "player_id": player.player_id,
                "name": player.name,
                "role": player.role.value if player.role else None,
                "team": player.team.value if player.team else None,
                "session_token_hash": player.session_token_hash
                or (token_digest(player.session_token) if player.session_token else None),
                "is_bot": player.is_bot,
                "color_index": player.color_index,
                "avatar_index": player.avatar_index,
                "avatar_image": player.avatar_image,
                "analytics_id": player.analytics_id,
                "selfie_sha256": player.selfie_sha256,
                "selfie_storage_name": player.selfie_storage_name,
                "ready": player.ready,
            }
            for player in game.players.values()
        ],
        "spectators": [
            {
                "spectator_id": spectator.spectator_id,
                "name": spectator.name,
                "session_token_hash": spectator.session_token_hash
                or (token_digest(spectator.session_token) if spectator.session_token else None),
                "color_index": spectator.color_index,
                "vision_mode": spectator.vision_mode,
                "analytics_id": spectator.analytics_id,
            }
            for spectator in game.spectators.values()
        ],
        "player_order": game.player_order,
        "host_token_hash": game.host_token_hash
        or (token_digest(game.host_token) if game.host_token else None),
        "host_player_id": game.host_player_id,
        "discussion_time": game.discussion_time,
        "proposal_time": game.proposal_time,
        "beta_test_mode": game.beta_test_mode,
        "beta_test_player_count": game.beta_test_player_count,
        "started_at": game.started_at,
        "current_leader_index": game.current_leader_index,
        "current_mission": game.current_mission,
        "mission_results": game.mission_results,
        "mission_history": game.mission_history,
        "proposal_history": game.proposal_history,
        "consecutive_rejections": game.consecutive_rejections,
        "proposed_team": game.proposed_team,
        "votes": game.votes,
        "pending_vote_result": game.pending_vote_result,
        "mission_cards": game.mission_cards,
        "night_acks": sorted(game.night_acks),
        "assassin_target": game.assassin_target,
        "winner": game.winner,
        "win_reason": game.win_reason,
        "pending_mission_outcome": game.pending_mission_outcome,
        "spotlight_player_id": game.spotlight_player_id,
        "rematch_ready": sorted(game.rematch_ready),
        "timer_kind": game.timer_kind,
        "timer_remaining": timer_remaining,
        "seat_recovery_codes": [
            {"digest": digest, "player_id": player_id, "expires_at": expires_at}
            for digest, (player_id, expires_at) in game.seat_recovery_codes.items()
        ],
        "display_pair_codes": [
            {"digest": digest, "expires_at": expires_at}
            for digest, expires_at in game.display_pair_codes.items()
        ],
        "spectrum_ratings": game.spectrum_ratings,
        "suspended": game.suspended,
        "inactive_since": game.inactive_since,
        "expires_at": game.expires_at,
        "active_elapsed_seconds": active_elapsed,
    }


def deserialize_game(state: dict, *, saved_at: float) -> GameState:
    if not isinstance(state, dict) or not isinstance(state.get("code"), str):
        raise ValueError("Invalid room snapshot")
    game = GameState(state["code"].upper())
    game.party_id = state.get("party_id") or game.party_id
    game.game_id = state.get("game_id")
    game.phase = GamePhase(state.get("phase", GamePhase.LOBBY.value))
    game.phase_started_at = float(state.get("phase_started_at", saved_at))
    for item in state.get("players", []):
        player = PlayerInfo(
            item["player_id"],
            item["name"],
            is_bot=bool(item.get("is_bot")),
            color_index=int(item.get("color_index", 0)),
            avatar_index=int(item.get("avatar_index", 0)),
        )
        player.role = Role(item["role"]) if item.get("role") else None
        player.team = Team(item["team"]) if item.get("team") else None
        player.session_token_hash = item.get("session_token_hash")
        player.avatar_image = item.get("avatar_image")
        player.analytics_id = valid_analytics_id(item.get("analytics_id"))
        player.selfie_sha256 = item.get("selfie_sha256")
        player.selfie_storage_name = item.get("selfie_storage_name")
        player.ready = bool(item.get("ready", player.is_bot))
        player.connected = False
        player.sid = None
        game.players[player.player_id] = player
    for item in state.get("spectators", []):
        spectator = SpectatorInfo(
            item["spectator_id"],
            item["name"],
            int(item.get("color_index", 0)),
            item.get("vision_mode", "blind"),
        )
        spectator.session_token_hash = item.get("session_token_hash")
        spectator.analytics_id = valid_analytics_id(item.get("analytics_id"))
        spectator.connected = False
        spectator.sid = None
        game.spectators[spectator.spectator_id] = spectator
    game.player_order = [
        player_id for player_id in state.get("player_order", []) if player_id in game.players
    ]
    game.host_token_hash = state.get("host_token_hash")
    game.host_player_id = state.get("host_player_id")
    game.discussion_time = int(state.get("discussion_time", 60))
    game.proposal_time = int(state.get("proposal_time", 60))
    game.beta_test_mode = bool(state.get("beta_test_mode"))
    game.beta_test_player_count = int(state.get("beta_test_player_count", 6))
    game.started_at = state.get("started_at")
    game.current_leader_index = int(state.get("current_leader_index", 0))
    game.current_mission = int(state.get("current_mission", 0))
    game.mission_results = list(state.get("mission_results", []))
    game.mission_history = list(state.get("mission_history", []))
    game.proposal_history = list(state.get("proposal_history", []))
    game.consecutive_rejections = int(state.get("consecutive_rejections", 0))
    game.proposed_team = list(state.get("proposed_team", []))
    game.votes = dict(state.get("votes", {}))
    game.pending_vote_result = state.get("pending_vote_result")
    game.mission_cards = dict(state.get("mission_cards", {}))
    game.night_acks = set(state.get("night_acks", []))
    game.assassin_target = state.get("assassin_target")
    game.winner = state.get("winner")
    game.win_reason = state.get("win_reason")
    game.pending_mission_outcome = state.get("pending_mission_outcome")
    spotlight_player_id = state.get("spotlight_player_id")
    game.spotlight_player_id = (
        spotlight_player_id if spotlight_player_id in game.players else None
    )
    game.rematch_ready = {
        player_id
        for player_id in state.get("rematch_ready", [])
        if player_id in game.players and not game.players[player_id].is_bot
    }
    game.timer_kind = state.get("timer_kind")
    remaining = state.get("timer_remaining")
    game.timer_remaining = max(0, int(remaining)) if remaining is not None else None
    game.timer_phase_key = None
    game.timer_deadline = None
    game.seat_recovery_codes = {
        item["digest"]: (item["player_id"], float(item["expires_at"]))
        for item in state.get("seat_recovery_codes", [])
        if item.get("expires_at", 0) > time.time()
    }
    game.display_pair_codes = {
        item["digest"]: float(item["expires_at"])
        for item in state.get("display_pair_codes", [])
        if item.get("expires_at", 0) > time.time()
    }
    game.spectrum_ratings = dict(state.get("spectrum_ratings", {}))
    # A process restart disconnects everyone and therefore suspends the room
    # from the latest durable save point.
    game.suspended = True
    game.inactive_since = float(state.get("inactive_since") or saved_at)
    game.expires_at = float(state.get("expires_at") or (saved_at + GAME_TTL_SECONDS))
    game.active_elapsed_seconds = float(state.get("active_elapsed_seconds", 0))
    game.active_since = None
    return game


def persist_game(game: GameState) -> None:
    global room_persistence_error_logged
    if app.config.get("TESTING") and not app.config.get("PERSIST_ROOMS_IN_TESTS"):
        return
    try:
        now = time.time()
        chat_store.save_room_snapshot(
            room_code=game.code,
            schema_version=ROOM_SCHEMA_VERSION,
            state=serialize_game(game),
            saved_at=now,
            inactive_since=game.inactive_since,
            expires_at=game.expires_at,
        )
        room_persistence_error_logged = False
    except Exception:
        if not room_persistence_error_logged:
            logger.exception("Could not persist active room")
            room_persistence_error_logged = True
    record_state_checkpoint(game, reason="authoritative_state_changed")


def load_persisted_games() -> None:
    now = time.time()
    for row in chat_store.room_snapshots():
        code = row["room_code"]
        try:
            if row["schema_version"] != ROOM_SCHEMA_VERSION:
                raise ValueError("unsupported snapshot version")
            if row["expires_at"] is not None and row["expires_at"] <= now:
                chat_store.delete_room_snapshot(code)
                continue
            game = deserialize_game(json.loads(row["state_json"]), saved_at=row["saved_at"])
            if game.expires_at and game.expires_at <= now:
                chat_store.delete_room_snapshot(code)
                continue
            games[code] = game
            game_activity[code] = time.monotonic()
            # A room created by a release predating normalized research tables
            # can still be resumed after this process restart. Establish its
            # parent/dimension rows before reconnect events try to update them.
            backfill_restored_research_game(game)
            for player in game.players.values():
                if player.session_token_hash:
                    session_tokens[player.session_token_hash] = (code, player.player_id)
            for spectator in game.spectators.values():
                if spectator.session_token_hash:
                    spectator_tokens[spectator.session_token_hash] = (
                        code,
                        spectator.spectator_id,
                    )
        except Exception:
            logger.exception("Ignoring invalid saved room %s", code)
            chat_store.delete_room_snapshot(code)


def has_connected_real_player(game: GameState) -> bool:
    return any(player.connected and not player.is_bot for player in game.players.values())


def suspend_game(game: GameState) -> None:
    if game.suspended:
        return
    now = time.time()
    if game.active_since:
        game.active_elapsed_seconds += max(0, now - game.active_since)
        game.active_since = None
    if game.timer_deadline:
        game.timer_remaining = max(0, math.ceil(game.timer_deadline - now))
    game.timer_phase_key = None
    game.timer_deadline = None
    game.suspended = True
    game.inactive_since = now
    game.expires_at = now + GAME_TTL_SECONDS
    emit_to_game(
        game.code,
        "room_suspended",
        {"expires_at": game.expires_at, "timer_remaining": game.timer_remaining},
    )
    record_product_event(
        "room_suspended",
        game=game,
        payload={
            "timer_kind": game.timer_kind,
            "timer_remaining_seconds": game.timer_remaining,
        },
    )
    persist_game(game)


def resume_game(game: GameState) -> None:
    if not game.suspended:
        return
    game.suspended = False
    game.inactive_since = None
    game.expires_at = None
    if game.started_at:
        game.active_since = time.time()
    if game.timer_kind and game.timer_remaining is not None:
        phase_key = str(uuid.uuid4())
        game.timer_phase_key = phase_key
        game.timer_deadline = time.time() + game.timer_remaining
        if game.timer_kind == "discussion":
            socketio.start_background_task(
                run_discussion_timer, game.code, phase_key, game.timer_remaining
            )
        elif game.timer_kind == "proposal":
            socketio.start_background_task(
                run_proposal_timer, game.code, phase_key, game.timer_remaining
            )
    game.timer_remaining = None
    emit_to_game(game.code, "room_resumed", {})
    record_product_event("room_resumed", game=game)
    persist_game(game)


def discard_game(
    game_code: str, *, notify: bool = False, reason: str = "host_ended"
) -> None:
    """Remove one game and all of its reconnect/authorization state."""
    with state_lock:
        game = games.get(game_code)
        if game:
            event_type = "game_expired" if reason == "expired" else "game_abandoned"
            record_product_event(
                event_type,
                game=game,
                payload={"reason": reason, "had_started": bool(game.started_at)},
            )
            if game.started_at:
                record_state_checkpoint(game, reason=event_type)
                if game.phase == GamePhase.GAME_OVER:
                    finalize_research_game(game, status="completed")
                else:
                    finalize_research_game(
                        game,
                        status="expired" if reason == "expired" else "abandoned",
                        abandonment_reason=reason,
                    )
        if notify:
            emit_to_game(game_code, "game_ended", {})
        # Remove still-connected clients from the Socket.IO room as well as
        # deleting application state. This matters if the short code is ever
        # reused while an old browser tab remains open.
        socketio.close_room(game_code, namespace="/")
        games.pop(game_code, None)
        game_activity.pop(game_code, None)
        for token, (token_game_code, _) in list(session_tokens.items()):
            if token_game_code == game_code:
                del session_tokens[token]
        for token, (token_game_code, _) in list(spectator_tokens.items()):
            if token_game_code == game_code:
                del spectator_tokens[token]
        for sid, info in list(sid_to_info.items()):
            if info.get("game_code") == game_code:
                del sid_to_info[sid]
        try:
            chat_store.delete_room_snapshot(game_code)
        except Exception:
            logger.exception("Could not delete saved room %s", game_code)


def disconnect_replaced_socket(sid: str | None) -> None:
    """Revoke an older tab after the same capability reconnects elsewhere."""
    if not sid:
        return
    sid_to_info.pop(sid, None)
    socketio.server.disconnect(sid, namespace="/")


def prune_disconnected_lobby_players(game: GameState) -> bool:
    """Disconnected lobby seats are durable and remain reclaimable."""
    return False


def cleanup_stale_games() -> None:
    now = time.time()
    with state_lock:
        candidates = [
            (game_code, games.get(game_code))
            for game_code, game in games.items()
            if game.expires_at is not None and game.expires_at <= now
        ]
    for game_code, game in candidates:
        if not game:
            continue
        with game.lock:
            if game.expires_at is not None and game.expires_at <= time.time():
                discard_game(game_code, notify=True, reason="expired")


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


def event_game(args) -> GameState | None:
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
            token_entry = (
                session_tokens.get(token_digest(token)) if isinstance(token, str) else None
            )
            if not token_entry and isinstance(token, str):
                token_entry = spectator_tokens.get(token_digest(token))
            game_code = token_entry[0] if token_entry else None
        return games.get(game_code)


def event_game_lock(args):
    game = event_game(args)
    return game.lock if game else nullcontext()


def protocol_actor() -> tuple[str, str | None, str | None]:
    info = sid_to_info.get(request.sid, {})
    actor_type = (
        "host_display"
        if info.get("is_host_screen")
        else "spectator"
        if info.get("spectator_id")
        else "player"
        if info.get("player_id")
        else "browser"
    )
    return (
        actor_type,
        info.get("player_id") or info.get("spectator_id"),
        info.get("analytics_id"),
    )


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
                "claim_seat",
                "pair_display",
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
                    target_game = event_game(args)
                    actor_type, actor_id, analytics_id = protocol_actor()
                    record_research_event(
                        "rate_limit_triggered",
                        game=target_game,
                        source="server_protocol",
                        category="reliability",
                        actor_type=actor_type,
                        actor_id=actor_id,
                        analytics_id=analytics_id,
                        payload={"action": func.__name__, "bucket": bucket},
                    )
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
                        target_game = event_game(args)
                        actor_type, actor_id, analytics_id = protocol_actor()
                        record_research_event(
                            "rate_limit_triggered",
                            game=target_game,
                            source="server_protocol",
                            category="reliability",
                            actor_type=actor_type,
                            actor_id=actor_id,
                            analytics_id=analytics_id,
                            payload={"action": func.__name__, "bucket": bucket},
                        )
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
                started = time.perf_counter()
                result = func(*args, **kwargs)
                if bucket != "analytics":
                    target_game = event_game(args)
                    actor_type, actor_id, analytics_id = protocol_actor()
                    data = args[0] if args and isinstance(args[0], dict) else {}
                    record_research_event(
                        "server_action_processed",
                        game=target_game,
                        source="server_protocol",
                        category="interaction",
                        actor_type=actor_type,
                        actor_id=actor_id,
                        analytics_id=analytics_id
                        or valid_analytics_id(data.get("analytics_id")),
                        payload={
                            "action": func.__name__,
                            "bucket": bucket,
                            "duration_ms": max(
                                0, round((time.perf_counter() - started) * 1000)
                            ),
                        },
                    )
                info = sid_to_info.get(request.sid)
                game_code = info.get("game_code") if info else None
                if game_code in games:
                    game_activity[game_code] = time.monotonic()
                    persist_game(games[game_code])
                return result

        return wrapper

    return decorator


def validate_host(sid: str, *, require_phase=None, allow_suspended: bool = False):
    info = sid_to_info.get(sid)
    if not info:
        raise ValueError("Host authorization required")
    game = games.get(info.get("game_code"))
    if not game:
        raise ValueError("Game not found")
    is_display = bool(
        info.get("is_host_screen")
        and game.host_token_hash
        and hmac.compare_digest(
            token_digest(info.get("host_token", "")), game.host_token_hash
        )
    )
    is_creator = bool(
        info.get("player_id")
        and info.get("player_id") == game.host_player_id
    )
    # Paired shared displays are deliberately read-only. The display-host
    # capability remains accepted only for the legacy test-only room creator.
    is_legacy_test_host = bool(
        app.config.get("TESTING") and is_display and game.host_player_id is None
    )
    if not is_creator and not is_legacy_test_host:
        raise ValueError("Host authorization required")
    if game.suspended and not allow_suspended:
        raise ValueError("The room is suspended until a player resumes it")
    if require_phase and game.phase != require_phase:
        raise ValueError(f"Wrong game phase: {game.phase}")
    return game


def emit_validation_error(error: Exception) -> None:
    message = str(error).lower()
    reason = (
        "authorization"
        if any(word in message for word in ("authorization", "not a player", "not connected"))
        else "wrong_phase"
        if "phase" in message
        else "wrong_actor"
        if any(word in message for word in ("not the current leader", "not the assassin"))
        else "not_found"
        if "not found" in message
        else "capacity"
        if any(word in message for word in ("full", "limit", "need 6-10"))
        else "duplicate"
        if any(word in message for word in ("already", "duplicate"))
        else "invalid_input"
    )
    event_info = getattr(request, "event", {}) or {}
    event_args = event_info.get("args", []) if isinstance(event_info, dict) else []
    game = event_game(event_args)
    actor_type, actor_id, analytics_id = protocol_actor()
    record_research_event(
        "server_validation_failed",
        game=game,
        source="server_protocol",
        category="reliability",
        actor_type=actor_type,
        actor_id=actor_id,
        analytics_id=analytics_id,
        payload={
            "action": str(event_info.get("message", "unknown"))[:64]
            if isinstance(event_info, dict)
            else "unknown",
            "reason": reason,
        },
    )
    emit("error", {"message": str(error)})


def public_spectrum_payload(game: GameState) -> dict[str, dict[str, float]]:
    return spectrum_average_positions(game)


def lobby_payload(game: GameState) -> dict:
    return {
        "players": game.public_players(),
        "player_order": [game.players[player_id].name for player_id in game.player_order],
        "public_spectrum": public_spectrum_payload(game),
        "role_manifest": role_manifest(game),
        "settings": {
            "discussion_time": game.discussion_time,
            "proposal_time": game.proposal_time,
            "beta_test_mode": game.beta_test_mode,
            "beta_test_player_count": game.beta_test_player_count,
        },
    }


def night_pending_names(game: GameState) -> list[str]:
    """Public confirmation status only; never includes roles or teams."""
    return [
        player.name
        for player in game.player_order_list()
        if player.player_id not in game.night_acks
    ]


def connected_spectator_count(game: GameState) -> int:
    return sum(spectator.connected for spectator in game.spectators.values())


def spectator_role_payload(game: GameState) -> list[dict]:
    """Private omniscient-spectator knowledge; never broadcast to the room."""
    return [
        {
            "player_id": player.player_id,
            "name": player.name,
            "role": player.role.value,
            "team": player.team.value,
        }
        for player in game.player_order_list()
        if player.role and player.team
    ]


def emit_spectator_count(game: GameState) -> None:
    emit_to_game(
        game.code,
        "spectator_count_updated",
        {"spectator_count": connected_spectator_count(game)},
    )


def spectator_snapshot(game: GameState, spectator: SpectatorInfo) -> dict:
    snapshot = build_state_snapshot(game, "")
    snapshot.update(
        {
            "is_spectator": True,
            "spectator_id": spectator.spectator_id,
            "my_name": spectator.name,
            "spectator_vision_mode": spectator.vision_mode,
        }
    )
    if spectator.vision_mode == "omniscient":
        snapshot["spectator_roles"] = spectator_role_payload(game)
    return snapshot


def validate_participant_name(game: GameState, name: str) -> str:
    name = name.strip()
    if not name or len(name) > 12:
        raise ValueError("Name must be between 1 and 12 characters")
    if not all(character.isalnum() or character == " " for character in name):
        raise ValueError("Name must contain only letters, numbers, and spaces")
    used_names = [player.name for player in game.players.values()]
    used_names.extend(spectator.name for spectator in game.spectators.values())
    if any(existing.lower() == name.lower() for existing in used_names):
        raise ValueError(f"Name '{name}' is already taken")
    return name


def add_beta_bots(game: GameState, target_count: int = 6) -> None:
    bot_number = 1
    existing_names = {player.name.lower() for player in game.players.values()}
    existing_names.update(spectator.name.lower() for spectator in game.spectators.values())
    while game.player_count() < target_count:
        while f"bot {bot_number}" in existing_names:
            bot_number += 1
        name = f"Bot {bot_number}"
        player = add_player(game, name, f"bot-{uuid.uuid4()}")
        player.is_bot = True
        player.ready = True
        player.sid = None
        existing_names.add(name.lower())
        bot_number += 1


def remove_beta_bots(game: GameState) -> None:
    for player_id, player in list(game.players.items()):
        if player.is_bot:
            game.players.pop(player_id, None)
            if player_id in game.player_order:
                game.player_order.remove(player_id)


def sync_beta_bots(game: GameState, target_count: int) -> None:
    while game.player_count() > target_count:
        bot_id = next(
            (player_id for player_id in reversed(game.player_order) if game.players[player_id].is_bot),
            None,
        )
        if bot_id is None:
            break
        game.players.pop(bot_id, None)
        game.player_order.remove(bot_id)
    add_beta_bots(game, target_count)


def bot_players(game: GameState) -> list[PlayerInfo]:
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
    if game.suspended:
        raise ValueError("The room is suspended. Resume your seat first.")
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
    while True:
        socketio.sleep(1)
        game = games.get(game_code)
        if not game:
            return
        with game.lock:
            if not game or game.timer_phase_key != phase_key:
                return  # cancelled or phase changed
            remaining = max(
                0, math.ceil((game.timer_deadline or time.time()) - time.time())
            )
            emit_to_game(game_code, "discussion_tick", {"remaining_seconds": remaining})
            if remaining <= 0:
                record_product_event(
                    "discussion_timer_expired",
                    game=game,
                    payload={"duration_seconds": game.discussion_time},
                )
                transition_to_team_proposal(game)
                return


def run_bot_discussion(game_code: str, phase_key: str | None, duration: int) -> None:
    """Give the table a brief beat, then let a bot leader continue."""
    pause(min(3, max(1, duration)))
    game = games.get(game_code)
    if not game:
        return
    with game.lock:
        if game.phase != GamePhase.DISCUSSION or game.timer_phase_key != phase_key:
            return
        game.timer_phase_key = None
        game.timer_deadline = None
        game.timer_kind = None
        game.timer_remaining = None
        emit_to_game(game.code, "discussion_end", {})
        transition_to_team_proposal(game)


def run_proposal_timer(game_code: str, phase_key: str, duration: int):
    while True:
        socketio.sleep(1)
        game = games.get(game_code)
        if not game:
            return
        with game.lock:
            if not game or game.timer_phase_key != phase_key:
                return
            remaining = max(
                0, math.ceil((game.timer_deadline or time.time()) - time.time())
            )
            emit_to_game(game_code, "proposal_tick", {"remaining_seconds": remaining})
            if remaining <= 0:
                # Advisory only: the leader can still finish their proposal.
                emit_to_game(game_code, "proposal_timer_expired", {})
                record_product_event(
                    "proposal_timer_expired",
                    game=game,
                    payload={"duration_seconds": game.proposal_time},
                )
                game.timer_remaining = 0
                persist_game(game)
                return


# ---------------------------------------------------------------------------
# Phase transition helpers
# ---------------------------------------------------------------------------


def start_round(game: GameState):
    game.phase = GamePhase.ROUND_START
    mark_phase_started(
        game,
        "round_started",
        {"leader_id": game.current_leader().player_id if game.current_leader() else None},
    )
    leader = game.current_leader()
    player_count = game.player_count()
    mission_sizes = MISSION_SIZES.get(player_count, [])
    log_game_event(
        game,
        "round_started",
        {
            "mission_num": game.current_mission + 1,
            "leader_name": leader.name if leader else "Unknown",
            "mission_size": game.mission_size(),
            "reject_count": game.consecutive_rejections,
        },
    )
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
            "mission_history": game.mission_history,
            "mission_sizes": mission_sizes,
            "requires_double_fail": game.requires_double_fail(),
            "game_started_at": game.started_at,
            "team_counts": {
                "good": sum(player.team.value == "good" for player in game.players.values()),
                "evil": sum(player.team.value == "evil" for player in game.players.values()),
            },
            # Player ordering info — needed by the leader's proposal screen
            "player_order": [game.players[pid].name for pid in game.player_order],
            "player_name_to_id": {
                game.players[pid].name: pid for pid in game.player_order
            },
        },
    )
    # Immediately go to discussion
    game.phase = GamePhase.DISCUSSION
    game.spotlight_player_id = None
    phase_key = str(uuid.uuid4()) if game.discussion_time else None
    game.timer_phase_key = phase_key
    game.timer_kind = "discussion" if phase_key else None
    game.timer_deadline = time.time() + game.discussion_time if phase_key else None
    game.timer_remaining = None
    mark_phase_started(
        game,
        "discussion_started",
        {"duration_seconds": game.discussion_time},
    )
    emit_to_game(
        game.code,
        "discussion_start",
        {
            "duration_seconds": game.discussion_time,
            "mission_num": game.current_mission + 1,
            "mission_size": game.mission_size(),
            "leader_name": leader.name if leader else "Unknown",
            "leader_id": leader.player_id if leader else None,
        },
    )
    if phase_key:
        socketio.start_background_task(
            run_discussion_timer, game.code, phase_key, game.discussion_time
        )
    if leader and leader.is_bot:
        if app.config.get("TESTING"):
            run_bot_discussion(game.code, phase_key, game.discussion_time)
        else:
            socketio.start_background_task(
                run_bot_discussion, game.code, phase_key, game.discussion_time
            )
    persist_game(game)


def transition_to_team_proposal(game: GameState):
    game.phase = GamePhase.TEAM_PROPOSAL
    game.spotlight_player_id = None
    game.proposed_team = []
    game.votes = {}
    game.mission_cards = {}
    leader = game.current_leader()
    phase_key = str(uuid.uuid4()) if game.proposal_time else None
    game.timer_phase_key = phase_key
    game.timer_kind = "proposal" if phase_key else None
    game.timer_deadline = time.time() + game.proposal_time if phase_key else None
    game.timer_remaining = None
    mark_phase_started(
        game,
        "proposal_started",
        {
            "duration_seconds": game.proposal_time,
            "leader_id": leader.player_id if leader else None,
        },
    )
    emit_to_game(
        game.code,
        "proposal_start",
        {
            "leader_name": leader.name if leader else "Unknown",
            "leader_id": leader.player_id if leader else None,
            "mission_size": game.mission_size(),
            "duration_seconds": game.proposal_time,
            "forced": game.consecutive_rejections >= 4,
            "player_order": [game.players[pid].name for pid in game.player_order],
            "player_name_to_id": {
                game.players[pid].name: pid for pid in game.player_order
            },
        },
    )
    if phase_key:
        socketio.start_background_task(
            run_proposal_timer, game.code, phase_key, game.proposal_time
        )
    if leader and leader.is_bot:
        team_ids = secure_random.sample(game.player_order, game.mission_size())
        submit_team_proposal(game, leader, team_ids)
    persist_game(game)


def transition_to_night_phase(game: GameState):
    game.phase = GamePhase.NIGHT_PHASE
    game.timer_phase_key = None
    game.timer_deadline = None
    game.timer_kind = None
    game.timer_remaining = None
    game.night_acks = set()
    mark_phase_started(game, "night_phase_started", {"player_count": game.player_count()})
    emit_to_game(
        game.code,
        "night_phase_start",
        {
            "confirmed": len(game.night_acks),
            "total_players": game.player_count(),
            "pending_names": night_pending_names(game),
        },
    )
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
    omniscient_roles = spectator_role_payload(game)
    for spectator in game.spectators.values():
        if spectator.sid and spectator.vision_mode == "omniscient":
            emit_to_player(
                spectator.sid,
                "spectator_roles_revealed",
                {"players": omniscient_roles},
            )
    if game.night_acks:
        emit_to_game(
            game.code,
            "night_phase_progress",
            {
                "confirmed": len(game.night_acks),
                "total": game.player_count(),
                "pending_names": night_pending_names(game),
            },
        )
    persist_game(game)


def submit_team_proposal(
    game: GameState, leader, team_ids: list[str]
) -> None:
    decision_ms = max(0, int((time.time() - game.phase_started_at) * 1000))
    validate_team_proposal(game, team_ids)
    game.proposed_team = team_ids
    game.timer_phase_key = None
    game.timer_deadline = None
    game.timer_kind = None
    game.timer_remaining = None
    forced = game.consecutive_rejections >= 4
    record_product_event(
        "team_proposal_submitted",
        game=game,
        actor_type="player",
        actor_id=leader.player_id,
        analytics_id=leader.analytics_id,
        payload={
            "decision_ms": decision_ms,
            "team_size": len(team_ids),
            "team_ids": list(team_ids),
            "forced": forced,
        },
        visibility="research_secret",
    )
    team_names = [game.players[pid].name for pid in team_ids]
    payload = {
        "team": team_names,
        "team_ids": team_ids,
        "leader_name": leader.name,
        "forced": forced,
    }
    log_game_event(game, "team_proposed", payload)
    emit_to_game(game.code, "team_proposed", payload)
    if forced:
        public_proposal = {
            "mission_num": game.current_mission + 1,
            "attempt": 5,
            "leader_name": leader.name,
            "team": team_names,
            "approve_count": 0,
            "reject_count": 0,
            "approved": True,
            "forced": True,
        }
        game.proposal_history.append(public_proposal)
        log_game_event(game, "team_forced_after_four_rejections", public_proposal)
        emit_to_game(
            game.code,
            "forced_team_selected",
            {
                "leader_name": leader.name,
                "team": team_names,
                "team_ids": team_ids,
            },
        )
        begin_proposed_mission(game, forced=True)
        return

    game.phase = GamePhase.TEAM_VOTE
    mark_phase_started(game, "team_vote_started", {"team_size": len(team_ids)})
    emit_to_game(game.code, "vote_start", payload)
    for bot in bot_players(game):
        record_vote(game, bot.player_id, secure_random.choice(("approve", "reject")))
    emit_vote_waiting(game)
    persist_game(game)


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


def emit_mission_waiting(game: GameState) -> None:
    """Broadcast the authoritative mission-card participation state.

    Card choices stay secret; only who has submitted is exposed.  Sending the
    complete set on every update lets clients recover from a reconnect or a
    missed/duplicate progress event instead of guessing which member played.
    """
    played_ids = [
        player_id
        for player_id in game.proposed_team
        if player_id in game.mission_cards
    ]
    remaining_ids = [
        player_id
        for player_id in game.proposed_team
        if player_id not in game.mission_cards
    ]
    emit_to_game(
        game.code,
        "mission_waiting",
        {
            "played": len(played_ids),
            "total": len(game.proposed_team),
            "played_player_ids": played_ids,
            "remaining_player_ids": remaining_ids,
            "played_players": [game.players[pid].name for pid in played_ids],
            "remaining_players": [game.players[pid].name for pid in remaining_ids],
        },
    )


def finish_mission(game: GameState, result: dict) -> None:
    game.phase = GamePhase.MISSION_REVEAL
    mark_phase_started(
        game,
        "mission_reveal_started",
        {"passed": bool(result["passed"]), "fail_count": result["fail_count"]},
    )
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
    persist_game(game)
    pause(4)
    history_item = {
        "mission_num": game.current_mission + 1,
        "leader_name": game.current_leader().name if game.current_leader() else "Unknown",
        "team": [game.players[pid].name for pid in game.proposed_team],
        "success_count": result["success_count"],
        "fail_count": result["fail_count"],
        "passed": result["passed"],
    }
    game.mission_history.append(history_item)
    log_game_event(
        game,
        "mission_completed",
        {
            **history_item,
            "cards_by_player": {
                game.players[player_id].name: card
                for player_id, card in game.mission_cards.items()
            },
        },
    )
    outcome = process_mission_result(game, result["passed"])
    emit_to_game(
        game.code,
        "mission_tracker_update",
        {
            "mission_results": game.mission_results,
            "good_wins": game.good_wins(),
            "evil_wins": game.evil_wins_count(),
            "mission_history": game.mission_history,
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
    leader = game.current_leader()
    if leader and leader.is_bot:
        advance_after_mission(game)


def play_bot_mission_cards(game: GameState) -> None:
    result = None
    for player_id in game.proposed_team:
        player = game.players[player_id]
        if not player.is_bot:
            continue
        card = "success"
        if player.team == Team.EVIL:
            card = secure_random.choice(("success", "fail"))
        result = record_mission_card(game, player_id, card)
    emit_mission_waiting(game)
    if result:
        finish_mission(game, result)


def begin_proposed_mission(
    game: GameState,
    *,
    forced: bool = False,
    proposal_attempt: int | None = None,
) -> None:
    """Start the selected quest party, optionally bypassing the fifth vote."""
    if proposal_attempt is None:
        proposal_attempt = game.consecutive_rejections + 1
    game.consecutive_rejections = 0
    game.phase = GamePhase.MISSION
    mark_phase_started(
        game,
        "mission_started",
        {
            "team_size": len(game.proposed_team),
            "forced": forced,
            "proposal_attempt": proposal_attempt,
        },
    )
    emit_to_game(
        game.code,
        "mission_start",
        {
            "team": [game.players[pid].name for pid in game.proposed_team],
            "team_ids": game.proposed_team,
            "mission_num": game.current_mission + 1,
            "forced": forced,
            "proposal_attempt": proposal_attempt,
        },
    )
    persist_game(game)
    play_bot_mission_cards(game)


def finish_vote(game: GameState, result: dict) -> None:
    game.phase = GamePhase.VOTE_REVEAL
    mark_phase_started(
        game,
        "vote_reveal_started",
        {"approved": bool(result["approved"])},
    )
    public_vote = {
        "mission_num": game.current_mission + 1,
        "attempt": game.consecutive_rejections + 1,
        "leader_name": game.current_leader().name if game.current_leader() else "Unknown",
        "team": [game.players[pid].name for pid in game.proposed_team],
        "approve_count": result["approve_count"],
        "reject_count": result["reject_count"],
        "approved": result["approved"],
    }
    game.proposal_history.append(public_vote)
    game.pending_vote_result = result
    log_game_event(
        game,
        "team_vote",
        {
            **public_vote,
            **result,
        },
    )
    emit_to_game(game.code, "vote_reveal", {**result, "team": public_vote["team"]})
    leader = game.current_leader()
    if leader and leader.is_bot:
        advance_after_vote(game)


def advance_after_vote(game: GameState) -> None:
    result = game.pending_vote_result
    if not result:
        raise ValueError("No revealed vote is awaiting confirmation")
    game.pending_vote_result = None
    proposal_attempt = game.consecutive_rejections + 1
    outcome = process_vote_result(game, result["approved"])
    if outcome == "mission":
        begin_proposed_mission(game, proposal_attempt=proposal_attempt)
    else:
        emit_to_game(
            game.code,
            "rejection_warning",
            {
                "consecutive": game.consecutive_rejections,
                "leader_name": (
                    game.current_leader().name if game.current_leader() else "Unknown"
                ),
                "leader_id": (
                    game.current_leader().player_id if game.current_leader() else None
                ),
            },
        )
        persist_game(game)
        pause(2)
        transition_to_team_proposal(game)


def run_bot_assassination(game: GameState) -> None:
    assassin = get_assassin(game)
    if not assassin or not assassin.is_bot:
        return
    targets = get_assassin_targets(game)
    if not targets:
        return
    target_id = secure_random.choice(targets).player_id
    result = process_assassination(game, target_id)
    record_product_event(
        "assassination_submitted",
        game=game,
        actor_type="bot",
        actor_id=assassin.player_id,
        payload={
            "decision_ms": 0,
            "target_player_id": target_id,
            "was_merlin": bool(result["was_merlin"]),
        },
        visibility="research_secret",
    )
    emit_to_game(game.code, "assassination_result", result)
    persist_game(game)
    pause(3)
    emit_to_game(game.code, "game_over", get_game_summary(game))
    log_game_event(game, "assassination", result)
    log_completed_game(game)


# ---------------------------------------------------------------------------
# SocketIO events
# ---------------------------------------------------------------------------


@socketio.on("connect")
def on_connect(auth=None):
    client_ip = request.remote_addr or "unknown"
    with state_lock:
        ip_connections = sum(1 for address in sid_to_ip.values() if address == client_ip)
        if (
            len(connected_sids) >= MAX_CONNECTIONS
            or ip_connections >= MAX_CONNECTIONS_PER_IP
        ):
            return False
        connected_sids.add(request.sid)
        sid_to_ip[request.sid] = client_ip
    return None


CLIENT_ANALYTICS_EVENTS = {
    "client_session_started",
    "socket_reconnected",
    "screen_viewed",
    "visibility_changed",
    "entry_mode_selected",
    "ui_control_activated",
    "wake_lock_acquired",
    "wake_lock_released",
    "wake_lock_failed",
    "help_opened",
    "role_card_opened",
    "chat_opened",
    "chat_closed",
    "chat_notification_opened",
    "selfie_prompt_shown",
    "selfie_capture_started",
    "selfie_permission_denied",
    "selfie_capture_failed",
    "victory_screen_viewed",
    "rematch_prompt_viewed",
    "spectator_mode_help_opened",
    "client_error",
}
CLIENT_ANALYTICS_KEYS = {
    "screen_class",
    "display_mode",
    "context",
    "role",
    "source",
    "reason",
    "error_category",
    "unread_count",
    "camera_permission",
    "vision_mode",
    "screen_id",
    "previous_screen_id",
    "visibility_state",
    "reconnect_count",
    "session_duration_ms",
    "control_id",
    "supported",
}
CLIENT_CONTEXT_KEYS = {
    "screen_class",
    "display_mode",
    "viewport_width_bucket",
    "viewport_height_bucket",
    "timezone_offset_minutes",
    "locale",
    "color_scheme",
    "reduced_motion",
    "touch_capable",
    "online",
    "navigation_ms",
}


@socketio.on("client_analytics")
@rate_limited("analytics")
def on_client_analytics(data):
    """Accept a small allowlisted UX event; free-form text is never stored."""
    try:
        data = require_object(data)
        event_type = require_string(data, "event_type", minimum=3, maximum=64)
        if event_type not in CLIENT_ANALYTICS_EVENTS:
            raise ValueError("Unsupported analytics event")
        raw_payload = data.get("payload", {})
        if not isinstance(raw_payload, dict) or len(raw_payload) > 10:
            raise ValueError("Invalid analytics payload")
        payload = {}
        for key, value in raw_payload.items():
            if key not in CLIENT_ANALYTICS_KEYS:
                continue
            if isinstance(value, bool):
                payload[key] = value
            elif isinstance(value, int) and not isinstance(value, bool):
                payload[key] = max(-1_000_000, min(value, 1_000_000))
            elif isinstance(value, str):
                payload[key] = value[:64]
        info = sid_to_info.get(request.sid, {})
        game = games.get(info.get("game_code"))
        analytics_id = valid_analytics_id(data.get("analytics_id")) or info.get(
            "analytics_id"
        )
        has_client_envelope = any(
            key in data
            for key in (
                "client_session_id",
                "client_event_id",
                "client_sequence",
                "client_occurred_at",
                "page",
            )
        )
        client_session_id = valid_analytics_id(data.get("client_session_id"))
        client_event_id = valid_analytics_id(data.get("client_event_id"))
        client_sequence = data.get("client_sequence")
        client_occurred_at = data.get("client_occurred_at")
        page = data.get("page")
        if has_client_envelope and (
            not client_session_id
            or not client_event_id
            or isinstance(client_sequence, bool)
            or not isinstance(client_sequence, int)
            or not 1 <= client_sequence <= 10_000_000
            or not isinstance(client_occurred_at, str)
            or not 20 <= len(client_occurred_at) <= 35
            or page not in {"player", "host"}
        ):
            raise ValueError("Invalid client event envelope")
        raw_context = data.get("client_context", {}) if has_client_envelope else {}
        if not isinstance(raw_context, dict) or len(raw_context) > 16:
            raise ValueError("Invalid client context")
        client_context = {}
        for key, value in raw_context.items():
            if key not in CLIENT_CONTEXT_KEYS:
                continue
            if isinstance(value, bool):
                client_context[key] = value
            elif isinstance(value, int) and not isinstance(value, bool):
                client_context[key] = max(-100_000, min(value, 1_000_000))
            elif isinstance(value, str):
                client_context[key] = value[:64]
        actor_type = "host_display" if info.get("is_host_screen") else (
            "spectator" if info.get("spectator_id") else (
                "player" if info.get("player_id") else "browser"
            )
        )
        actor_id = info.get("player_id") or info.get("spectator_id")
        record_product_event(
            event_type,
            game=game,
            actor_type=actor_type,
            actor_id=actor_id,
            analytics_id=analytics_id,
            payload=payload,
            event_id=client_event_id or None,
            client={
                "session_id": client_session_id,
                "event_id": client_event_id,
                "sequence": client_sequence,
                "occurred_at": client_occurred_at,
                "uptime_ms": max(
                    0,
                    min(
                        int(data.get("client_uptime_ms", 0)),
                        86_400_000,
                    ),
                )
                if isinstance(data.get("client_uptime_ms", 0), (int, float))
                and not isinstance(data.get("client_uptime_ms", 0), bool)
                else None,
                "page": page,
                "context": client_context,
            }
            if has_client_envelope
            else None,
        )
    except ValueError:
        return


@socketio.on("disconnect")
def on_disconnect(reason=None):
    sid = request.sid
    with state_lock:
        connected_sids.discard(sid)
        sid_to_ip.pop(sid, None)
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
            if game.host_sid == sid:
                game.host_sid = None
            if not has_connected_real_player(game):
                suspend_game(game)
            else:
                persist_game(game)
            record_product_event(
                "host_display_disconnected",
                game=game,
                actor_type="host_display",
                analytics_id=info.get("analytics_id"),
                payload={"reason": str(reason or "unknown")[:32]},
            )
            return
        spectator_id = info.get("spectator_id")
        if spectator_id and spectator_id in game.spectators:
            spectator = game.spectators[spectator_id]
            if spectator.sid == sid:
                spectator.connected = False
                spectator.sid = None
                emit_spectator_count(game)
                record_product_event(
                    "spectator_disconnected",
                    game=game,
                    actor_type="spectator",
                    actor_id=spectator_id,
                    analytics_id=spectator.analytics_id,
                    payload={"reason": str(reason or "unknown")[:32]},
                )
            persist_game(game)
            return
        player_id = info.get("player_id")
        if player_id and player_id in game.players:
            player = game.players[player_id]
            # A reconnect may have replaced this socket while its stale
            # disconnect callback waited for the room lock.
            if player.sid != sid:
                return
            player.connected = False
            player.sid = None
            if game.phase == GamePhase.LOBBY:
                player.ready = False
            emit_to_game(
                game_code,
                "player_disconnected",
                {
                    "player_id": player_id,
                    "player_name": game.players[player_id].name,
                    "players": game.public_players(),
                },
            )
            record_product_event(
                "player_disconnected",
                game=game,
                actor_type="player",
                actor_id=player_id,
                analytics_id=player.analytics_id,
                payload={"reason": str(reason or "unknown")[:32]},
            )
            if not has_connected_real_player(game):
                suspend_game(game)
            else:
                persist_game(game)


# --- Host screen registration ---


@socketio.on("session_status")
@rate_limited("reconnect_game")
def on_session_status(data):
    """Validate a remembered browser capability without resuming the room."""
    try:
        cleanup_stale_games()
        data = require_object(data)
        token = require_string(data, "session_token", minimum=32, maximum=128)
        digest = token_digest(token)
        entry = session_tokens.get(digest)
        spectator_entry = spectator_tokens.get(digest)
        if entry:
            code, player_id = entry
            game = games.get(code)
            player = game.players.get(player_id) if game else None
            if not game or not player:
                raise ValueError("Saved session is no longer available")
            emit(
                "session_status",
                {
                    "available": True,
                    "room_code": code,
                    "name": player.name,
                    "is_host": player_id == game.host_player_id,
                    "is_spectator": False,
                    "phase": game.phase.value,
                    "suspended": game.suspended,
                    "expires_at": game.expires_at,
                },
            )
            return
        if spectator_entry:
            code, spectator_id = spectator_entry
            game = games.get(code)
            spectator = game.spectators.get(spectator_id) if game else None
            if not game or not spectator:
                raise ValueError("Saved session is no longer available")
            emit(
                "session_status",
                {
                    "available": True,
                    "room_code": code,
                    "name": spectator.name,
                    "is_host": False,
                    "is_spectator": True,
                    "phase": game.phase.value,
                    "suspended": game.suspended,
                    "expires_at": game.expires_at,
                },
            )
            return
        raise ValueError("Saved session is no longer available")
    except ValueError as error:
        emit("session_status", {"available": False, "message": str(error)})


@socketio.on("request_display_pairing")
@rate_limited("pair_display")
def on_request_display_pairing():
    try:
        game = validate_host(request.sid, allow_suspended=True)
        now = time.time()
        game.display_pair_codes = {
            digest: expires_at
            for digest, expires_at in game.display_pair_codes.items()
            if expires_at > now
        }
        for _ in range(20):
            code = f"{secrets.randbelow(1_000_000):06d}"
            digest = token_digest(code)
            if digest not in game.display_pair_codes:
                break
        else:
            raise ValueError("Could not issue a display pairing code")
        game.display_pair_codes[digest] = now + 300
        actor_type, actor_id, analytics_id = protocol_actor()
        record_product_event(
            "display_pairing_requested",
            game=game,
            actor_type=actor_type,
            actor_id=actor_id,
            analytics_id=analytics_id,
            payload={"expires_in_seconds": 300},
        )
        emit(
            "display_pairing_code",
            {"room_code": game.code, "code": code, "expires_in": 300},
        )
    except ValueError as error:
        emit_validation_error(error)


@socketio.on("pair_host_display")
@rate_limited("pair_display")
def on_pair_host_display(data):
    try:
        data = require_object(data)
        game_code = require_string(data, "room_code", minimum=4, maximum=4).upper()
        analytics_id = valid_analytics_id(data.get("analytics_id"))
        pairing_code = require_string(data, "pairing_code", minimum=6, maximum=6)
        if not pairing_code.isdigit():
            raise ValueError("Pairing code must contain six digits")
        game = games.get(game_code)
        if not game:
            raise ValueError("Room not found")
        expires_at = game.display_pair_codes.pop(token_digest(pairing_code), None)
        if not expires_at or expires_at <= time.time():
            raise ValueError("Pairing code is invalid or expired")
        if sid_to_info.get(request.sid):
            raise ValueError("This browser is already in a game")
        disconnect_replaced_socket(game.host_sid)
        host_token = secrets.token_urlsafe(32)
        game.host_token = host_token
        game.host_token_hash = token_digest(host_token)
        game.host_sid = request.sid
        join_room(game.code)
        sid_to_info[request.sid] = {
            "game_code": game.code,
            "is_host_screen": True,
            "host_token": host_token,
            "analytics_id": analytics_id,
        }
        record_product_event(
            "host_display_paired",
            game=game,
            actor_type="host_display",
            analytics_id=analytics_id,
        )
        emit(
            "display_paired",
            {"room_code": game.code, "host_token": host_token},
        )
    except ValueError as error:
        emit("display_pairing_failed", {"message": str(error)})


@socketio.on("register_host_screen")
@rate_limited("register_host")
def on_register_host_screen(data):
    try:
        cleanup_stale_games()
        data = require_object(data)
        game_code = require_string(data, "game_code", minimum=4, maximum=4).upper()
        host_token = require_string(data, "host_token", minimum=32, maximum=128)
        analytics_id = valid_analytics_id(data.get("analytics_id"))
        game = games.get(game_code)
        if (
            not game
            or not game.host_token_hash
            or not hmac.compare_digest(token_digest(host_token), game.host_token_hash)
        ):
            raise ValueError("Game not found or host authorization invalid")
        sid = request.sid
        existing_info = sid_to_info.get(sid)
        if existing_info and (
            not existing_info.get("is_host_screen")
            or existing_info.get("game_code") != game_code
        ):
            raise ValueError("This connection is already in another game")
        if game.host_sid != sid:
            disconnect_replaced_socket(game.host_sid)
        game.host_sid = sid
        join_room(game_code)
        sid_to_info[sid] = {
            "game_code": game_code,
            "is_host_screen": True,
            "host_token": host_token,
            "analytics_id": analytics_id,
        }
        record_product_event(
            "host_display_reconnected",
            game=game,
            actor_type="host_display",
            analytics_id=analytics_id,
        )
        player_count = game.player_count()
        emit(
            "host_registered",
            {
                "code": game_code,
                "join_url": public_base_url(),
                "players": game.public_players(),
                "player_order": [game.players[player_id].name for player_id in game.player_order],
                "public_spectrum": public_spectrum_payload(game),
                "role_manifest": role_manifest(game),
                "phase": game.phase,
                "mission_sizes": MISSION_SIZES.get(player_count, []),
                "mission_results": game.mission_results,
                "mission_history": game.mission_history,
                "proposal_history": game.proposal_history,
                "current_mission": game.current_mission,
                "consecutive_rejections": game.consecutive_rejections,
                "current_leader": game.current_leader().name
                if game.current_leader()
                else "",
                "discussion_time": game.discussion_time,
                "proposal_time": game.proposal_time,
                "timer_kind": game.timer_kind,
                "timer_remaining": (
                    game.timer_remaining
                    if game.suspended
                    else max(0, math.ceil(game.timer_deadline - time.time()))
                    if game.timer_deadline
                    else None
                ),
                "game_started_at": game.started_at,
                "game_elapsed_seconds": int(
                    game.active_elapsed_seconds
                    + (time.time() - game.active_since if game.active_since else 0)
                ),
                "suspended": game.suspended,
                "expires_at": game.expires_at,
                "night_confirmed": len(game.night_acks),
                "night_total": game.player_count(),
                "night_pending_names": night_pending_names(game),
                "spectator_count": connected_spectator_count(game),
                "pending_mission_outcome": game.pending_mission_outcome,
                "spotlight_player_id": game.spotlight_player_id,
                "rematch_ready_ids": sorted(game.rematch_ready),
                "vote_reveal_pending": game.pending_vote_result is not None,
                "proposed_team": [
                    game.players[pid].name
                    for pid in game.proposed_team
                    if pid in game.players
                ],
                "proposed_team_ids": [
                    pid for pid in game.proposed_team if pid in game.players
                ],
                # Before reveal the shared display may show participation, but
                # never the choices themselves.
                "votes": {
                    game.players[pid].name: (
                        vote if game.phase == GamePhase.VOTE_REVEAL else None
                    )
                    for pid, vote in game.votes.items()
                    if pid in game.players
                },
                "mission_cards_played": len(game.mission_cards),
                "mission_cards_played_ids": [
                    pid for pid in game.proposed_team if pid in game.mission_cards
                ],
                "latest_mission": (
                    game.mission_history[-1] if game.mission_history else None
                ),
                "recent_chat": recent_chat_payload(game),
                "summary": get_game_summary(game)
                if game.phase == GamePhase.GAME_OVER
                else None,
                "assassin_name": (
                    get_assassin(game).name
                    if game.phase == GamePhase.ASSASSIN_PHASE and get_assassin(game)
                    else None
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
        if not app.config.get("TESTING"):
            raise ValueError("Create rooms from a player phone, then pair this display")
        analytics_id = valid_analytics_id(data.get("analytics_id")) if isinstance(data, dict) else None
        cleanup_stale_games()
        with state_lock:
            sid = request.sid
            existing_info = sid_to_info.get(sid)
            existing_game = (
                games.get(existing_info.get("game_code"))
                if existing_info and existing_info.get("is_host_screen")
                else None
            )
            if existing_info and not existing_game:
                raise ValueError("This connection is already in another game")
            if existing_game:
                emit(
                    "game_created",
                    {
                        "room_code": existing_game.code,
                        "host_token": existing_info.get("host_token")
                        or existing_game.host_token,
                        "join_url": public_base_url(),
                    },
                )
                return
            if len(games) >= MAX_GAMES:
                raise ValueError("The server has reached its active-game limit")
            code = generate_game_code(set(games.keys()))
            game = GameState(code)
            game.host_token = secrets.token_urlsafe(32)
            game.host_token_hash = token_digest(game.host_token)
            games[code] = game
            game_activity[code] = time.monotonic()
            game.host_sid = sid
            join_room(code)
            sid_to_info[sid] = {
                "game_code": code,
                "is_host_screen": True,
                "host_token": game.host_token,
                "analytics_id": analytics_id,
            }
            record_product_event(
                "room_created",
                game=game,
                actor_type="host_display",
                analytics_id=analytics_id,
                payload={"creation_mode": "host_display"},
            )
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


@socketio.on("create_player_game")
@rate_limited("create_game")
def on_create_player_game(data):
    """Create a room from a phone while occupying a normal player seat."""
    try:
        data = require_object(data)
        name = require_string(data, "player_name", minimum=1, maximum=12)
        analytics_id = valid_analytics_id(data.get("analytics_id"))
        cleanup_stale_games()
        with state_lock:
            sid = request.sid
            if sid_to_info.get(sid):
                raise ValueError("This browser is already in another game")
            if len(games) >= MAX_GAMES:
                raise ValueError("The server has reached its active-game limit")
            code = generate_game_code(set(games.keys()))
            game = GameState(code)
            game.host_token = secrets.token_urlsafe(32)
            game.host_token_hash = token_digest(game.host_token)
            player_id = str(uuid.uuid4())
            player = add_player(game, name, player_id)
            player.analytics_id = analytics_id
            token = secrets.token_urlsafe(32)
            player.session_token = token
            player.session_token_hash = token_digest(token)
            player.sid = sid
            game.host_player_id = player_id
            games[code] = game
            game_activity[code] = time.monotonic()
            session_tokens[player.session_token_hash] = (code, player_id)
            join_room(code)
            sid_to_info[sid] = {
                "game_code": code,
                "player_id": player_id,
                "analytics_id": analytics_id,
            }
            record_product_event(
                "room_created",
                game=game,
                actor_type="player",
                actor_id=player_id,
                analytics_id=analytics_id,
                payload={"creation_mode": "player_host"},
            )
            record_product_event(
                "player_joined",
                game=game,
                actor_type="player",
                actor_id=player_id,
                analytics_id=analytics_id,
                payload={"join_method": "created_room", "player_count": 1},
            )
        emit(
            "join_success",
            {
                "player_id": player_id,
                "session_token": token,
                "player_name": player.name,
                "is_host": True,
                "room_code": code,
                "players": game.public_players(),
                "public_spectrum": public_spectrum_payload(game),
                "role_manifest": role_manifest(game),
                "settings": lobby_payload(game)["settings"],
            },
        )
    except ValueError as error:
        emit_validation_error(error)


# --- Player joins ---


@socketio.on("join_game")
@rate_limited("join_game")
def on_join_game(data):
    try:
        cleanup_stale_games()
        data = require_object(data)
        code = require_string(data, "room_code", minimum=4, maximum=4).upper()
        name = require_string(data, "player_name", minimum=1, maximum=12)
        analytics_id = valid_analytics_id(data.get("analytics_id"))
        game = games.get(code)
        if not game:
            raise ValueError("Room not found. Check the code and try again.")
        sid = request.sid
        existing_info = sid_to_info.get(sid)
        if existing_info:
            existing_game = games.get(existing_info.get("game_code"))
            existing_player = (
                existing_game.players.get(existing_info.get("player_id"))
                if existing_game and existing_info.get("player_id")
                else None
            )
            if (
                existing_game is game
                and game.phase == GamePhase.LOBBY
                and existing_player
                and existing_player.name == name
                and existing_player.session_token
            ):
                emit(
                    "join_success",
                    {
                        "player_id": existing_player.player_id,
                        "session_token": existing_player.session_token,
                        "player_name": existing_player.name,
                        "is_host": existing_player.player_id == game.host_player_id,
                        "room_code": code,
                        "players": game.public_players(),
                        "public_spectrum": public_spectrum_payload(game),
                        "role_manifest": role_manifest(game),
                        "settings": lobby_payload(game)["settings"],
                    },
                )
                return
            raise ValueError("This connection is already in another game")
        validate_participant_name(game, name)
        if game.beta_test_mode and game.player_count() >= game.beta_test_player_count:
            bot_id = next(
                (player_id for player_id in reversed(game.player_order) if game.players[player_id].is_bot),
                None,
            )
            if bot_id is not None:
                game.players.pop(bot_id, None)
                game.player_order.remove(bot_id)
        player_id = str(uuid.uuid4())
        player = add_player(game, name, player_id)
        player.analytics_id = analytics_id
        token = secrets.token_urlsafe(32)
        player.session_token = token
        player.session_token_hash = token_digest(token)
        player.sid = sid
        session_tokens[player.session_token_hash] = (code, player_id)
        join_room(code)
        sid_to_info[sid] = {
            "game_code": code,
            "player_id": player_id,
            "analytics_id": analytics_id,
        }
        resume_game(game)
        record_product_event(
            "player_joined",
            game=game,
            actor_type="player",
            actor_id=player_id,
            analytics_id=analytics_id,
            payload={"join_method": "room_code", "player_count": game.player_count()},
        )
        emit(
            "join_success",
            {
                "player_id": player_id,
                "session_token": token,
                "player_name": player.name,
                "is_host": player.player_id == game.host_player_id,
                "room_code": code,
                "players": game.public_players(),
                "public_spectrum": public_spectrum_payload(game),
                "role_manifest": role_manifest(game),
                "settings": {
                    "discussion_time": game.discussion_time,
                    "proposal_time": game.proposal_time,
                    "beta_test_mode": game.beta_test_mode,
                    "beta_test_player_count": game.beta_test_player_count,
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
                "role_manifest": role_manifest(game),
            },
        )
    except ValueError as error:
        emit_validation_error(error)


@socketio.on("join_spectator")
@rate_limited("join_game")
def on_join_spectator(data):
    try:
        cleanup_stale_games()
        data = require_object(data)
        code = require_string(data, "room_code", minimum=4, maximum=4).upper()
        name = require_string(data, "spectator_name", minimum=1, maximum=12)
        vision_mode = data.get("vision_mode", "blind")
        analytics_id = valid_analytics_id(data.get("analytics_id"))
        if vision_mode not in {"blind", "omniscient"}:
            raise ValueError("Choose blind or all-knowing spectator mode")
        game = games.get(code)
        if not game:
            raise ValueError("Room not found. Check the code and try again.")
        if sid_to_info.get(request.sid):
            raise ValueError("This connection is already in another game")
        if len(game.spectators) >= 20:
            raise ValueError("Spectator gallery is full")
        name = validate_participant_name(game, name)
        spectator_id = str(uuid.uuid4())
        spectator = SpectatorInfo(
            spectator_id,
            name,
            color_index=(game.player_count() + len(game.spectators)) % 10,
            vision_mode=vision_mode,
        )
        spectator.analytics_id = analytics_id
        token = secrets.token_urlsafe(32)
        spectator.session_token = token
        spectator.session_token_hash = token_digest(token)
        spectator.sid = request.sid
        game.spectators[spectator_id] = spectator
        spectator_tokens[spectator.session_token_hash] = (game.code, spectator_id)
        join_room(game.code)
        sid_to_info[request.sid] = {
            "game_code": game.code,
            "spectator_id": spectator_id,
            "analytics_id": analytics_id,
        }
        snapshot = spectator_snapshot(game, spectator)
        snapshot["recent_chat"] = recent_chat_payload(game)
        emit(
            "spectator_join_success",
            {"session_token": token, "snapshot": snapshot},
        )
        emit_spectator_count(game)
        record_product_event(
            "spectator_joined",
            game=game,
            actor_type="spectator",
            actor_id=spectator_id,
            analytics_id=analytics_id,
            payload={"vision_mode": vision_mode},
        )
    except ValueError as error:
        emit_validation_error(error)


# --- Reconnect ---


@socketio.on("reconnect_game")
@rate_limited("reconnect_game")
def on_reconnect_game(data):
    try:
        cleanup_stale_games()
        data = require_object(data)
        token = require_string(data, "session_token", minimum=32, maximum=128)
        analytics_id = valid_analytics_id(data.get("analytics_id"))
        digest = token_digest(token)
        entry = session_tokens.get(digest)
        spectator_entry = spectator_tokens.get(digest)
        if not entry and spectator_entry:
            game_code, spectator_id = spectator_entry
            game = games.get(game_code)
            spectator = game.spectators.get(spectator_id) if game else None
            if not game or not spectator:
                raise ValueError("Spectator session no longer exists.")
            existing_info = sid_to_info.get(request.sid)
            if existing_info and (
                existing_info.get("game_code") != game_code
                or existing_info.get("spectator_id") != spectator_id
            ):
                raise ValueError("This connection is already in another game")
            if spectator.sid != request.sid:
                disconnect_replaced_socket(spectator.sid)
            spectator.sid = request.sid
            spectator.connected = True
            spectator.session_token = token
            if analytics_id:
                spectator.analytics_id = analytics_id
            join_room(game_code)
            sid_to_info[request.sid] = {
                "game_code": game_code,
                "spectator_id": spectator_id,
                "analytics_id": spectator.analytics_id,
            }
            snapshot = spectator_snapshot(game, spectator)
            snapshot["recent_chat"] = recent_chat_payload(game)
            emit("state_snapshot", snapshot)
            emit_spectator_count(game)
            record_product_event(
                "spectator_reconnected",
                game=game,
                actor_type="spectator",
                actor_id=spectator_id,
                analytics_id=spectator.analytics_id,
            )
            return
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
        existing_info = sid_to_info.get(sid)
        if existing_info and (
            existing_info.get("game_code") != game_code
            or existing_info.get("player_id") != player_id
        ):
            raise ValueError("This connection is already in another game")
        old_sid = player.sid
        if old_sid != sid:
            disconnect_replaced_socket(old_sid)
        player.sid = sid
        player.connected = True
        player.session_token = token
        if analytics_id:
            player.analytics_id = analytics_id
        join_room(game_code)
        sid_to_info[sid] = {
            "game_code": game_code,
            "player_id": player_id,
            "analytics_id": player.analytics_id,
        }
        resume_game(game)
        record_product_event(
            "player_reconnected",
            game=game,
            actor_type="player",
            actor_id=player_id,
            analytics_id=player.analytics_id,
        )
        snapshot = build_state_snapshot(game, player_id)
        snapshot["recent_chat"] = recent_chat_payload(game)
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
        emit("reconnect_failed", {"message": str(error)})


@socketio.on("request_seat_recovery")
@rate_limited()
def on_request_seat_recovery(data):
    """Let the authenticated host issue a short-lived code for one lost phone."""
    try:
        game = validate_host(request.sid, allow_suspended=True)
        data = require_object(data)
        player_id = require_string(data, "player_id", minimum=32, maximum=64)
        player = game.players.get(player_id)
        if not player:
            raise ValueError("Player not found")
        if player.is_bot:
            raise ValueError("Bot seats cannot be recovered")
        if player.connected:
            raise ValueError("That player is still connected")
        now = time.time()
        for code, (_, expires_at) in list(game.seat_recovery_codes.items()):
            if expires_at <= now:
                del game.seat_recovery_codes[code]
        for code, (recover_player_id, _) in list(game.seat_recovery_codes.items()):
            if recover_player_id == player_id:
                del game.seat_recovery_codes[code]
        for _ in range(20):
            code = f"{secrets.randbelow(1_000_000):06d}"
            if token_digest(code) not in game.seat_recovery_codes:
                break
        else:
            raise ValueError("Could not issue a recovery code")
        game.seat_recovery_codes[token_digest(code)] = (player_id, now + 300)
        actor_type, actor_id, analytics_id = protocol_actor()
        record_product_event(
            "seat_recovery_issued",
            game=game,
            actor_type=actor_type,
            actor_id=actor_id,
            analytics_id=analytics_id,
            payload={"target_player_id": player_id, "expires_in_seconds": 300},
            visibility="research_secret",
        )
        emit(
            "seat_recovery_code",
            {"player_id": player_id, "player_name": player.name, "code": code, "expires_in": 300},
        )
    except ValueError as error:
        emit_validation_error(error)


@socketio.on("claim_player_seat")
@rate_limited("claim_seat")
def on_claim_player_seat(data):
    """Move a disconnected seat to a replacement browser with host approval."""
    try:
        cleanup_stale_games()
        data = require_object(data)
        game_code = require_string(data, "room_code", minimum=4, maximum=4).upper()
        recovery_code = require_string(data, "recovery_code", minimum=6, maximum=6)
        analytics_id = valid_analytics_id(data.get("analytics_id"))
        if not recovery_code.isdigit():
            raise ValueError("Recovery code must contain six digits")
        game = games.get(game_code)
        if not game:
            raise ValueError("Room not found")
        if sid_to_info.get(request.sid):
            raise ValueError("This browser is already in a game")
        entry = game.seat_recovery_codes.pop(token_digest(recovery_code), None)
        if not entry or entry[1] < time.time():
            raise ValueError("Recovery code is invalid or expired")
        player = game.players.get(entry[0])
        if not player or player.connected or player.is_bot:
            raise ValueError("That seat is no longer available")

        old_token_hash = player.session_token_hash
        if old_token_hash:
            session_tokens.pop(old_token_hash, None)
        new_token = secrets.token_urlsafe(32)
        player.session_token = new_token
        player.session_token_hash = token_digest(new_token)
        player.sid = request.sid
        player.connected = True
        if analytics_id:
            player.analytics_id = analytics_id
        session_tokens[player.session_token_hash] = (game.code, player.player_id)
        join_room(game.code)
        sid_to_info[request.sid] = {
            "game_code": game.code,
            "player_id": player.player_id,
            "analytics_id": player.analytics_id,
        }
        resume_game(game)
        record_product_event(
            "seat_recovered",
            game=game,
            actor_type="player",
            actor_id=player.player_id,
            analytics_id=player.analytics_id,
            payload={"replaced_token": bool(old_token_hash)},
        )
        snapshot = build_state_snapshot(game, player.player_id)
        snapshot["recent_chat"] = recent_chat_payload(game)
        emit(
            "seat_recovered",
            {"session_token": new_token, "snapshot": snapshot},
        )
        emit_to_game(
            game.code,
            "player_reconnected",
            {
                "player_id": player.player_id,
                "player_name": player.name,
                "players": game.public_players(),
            },
        )
    except ValueError as error:
        emit("seat_recovery_failed", {"message": str(error)})


# --- Lobby management ---


@socketio.on("update_spectrum_ratings")
@rate_limited()
def on_update_spectrum_ratings(data):
    try:
        game, rater = validate_caller(request.sid)
        data = require_object(data)
        positions = data.get("positions")
        if not isinstance(positions, dict) or len(positions) > 10:
            raise ValueError("positions must be an object with at most 10 players")
        clean_positions = {}
        for player_id, position in positions.items():
            if not isinstance(player_id, str) or player_id not in game.players:
                raise ValueError("Player is not in this game")
            if not isinstance(position, dict):
                raise ValueError("Each position must be an object")
            x = position.get("x")
            y = position.get("y")
            if (
                isinstance(x, bool)
                or isinstance(y, bool)
                or not isinstance(x, (int, float))
                or not isinstance(y, (int, float))
                or not math.isfinite(x)
                or not math.isfinite(y)
                or not 0 <= x <= 1
                or not 0 <= y <= 1
            ):
                raise ValueError("Spectrum coordinates must be between 0 and 1")
            clean_positions[player_id] = {
                "x": round(float(x), 4),
                "y": round(float(y), 4),
            }
        game.spectrum_ratings[rater.player_id] = clean_positions
        record_product_event(
            "spectrum_ratings_updated",
            game=game,
            actor_type="player",
            actor_id=rater.player_id,
            analytics_id=rater.analytics_id,
            payload={
                "positions": clean_positions,
                "target_count": len(clean_positions),
            },
            visibility="research_secret",
        )
        emit_to_game(
            game.code,
            "public_spectrum_updated",
            {"positions": public_spectrum_payload(game)},
        )
    except ValueError as error:
        emit_validation_error(error)


@socketio.on("reorder_players")
@rate_limited()
def on_reorder_players(data):
    try:
        game = validate_host(request.sid, require_phase=GamePhase.LOBBY)
        data = require_object(data)
        ordered_names = require_string_list(data, "order")
        reorder_players(game, ordered_names)
        record_product_event(
            "roster_reordered",
            game=game,
            actor_type="host_display",
            analytics_id=sid_to_info.get(request.sid, {}).get("analytics_id"),
            payload={"player_order_ids": list(game.player_order)},
        )
        emit_to_game(
            game.code,
            "lobby_update",
            lobby_payload(game),
        )
    except ValueError as error:
        emit_validation_error(error)


@socketio.on("select_avatar")
@rate_limited()
def on_select_avatar(data):
    try:
        game, player = validate_caller(request.sid, require_phase=GamePhase.LOBBY)
        data = require_object(data)
        player.avatar_index = require_integer(data, "avatar_index", minimum=0, maximum=9)
        player.avatar_image = None
        player.selfie_sha256 = None
        player.selfie_storage_name = None
        record_product_event(
            "avatar_selected",
            game=game,
            actor_type="player",
            actor_id=player.player_id,
            analytics_id=player.analytics_id,
            payload={"avatar_index": player.avatar_index},
        )
        emit_to_game(game.code, "lobby_update", lobby_payload(game))
    except ValueError as error:
        emit_validation_error(error)


@socketio.on("select_selfie")
@rate_limited()
def on_select_selfie(data):
    global selfie_persistence_error_logged
    game = None
    player = None
    try:
        game, player = validate_caller(request.sid, require_phase=GamePhase.LOBBY)
        data = require_object(data)
        image = require_string(data, "image", minimum=100, maximum=200_000)
        if not image.startswith("data:image/jpeg;base64,"):
            raise ValueError("Selfie must be a resized JPEG image")
        try:
            decoded = base64.b64decode(image.partition(",")[2], validate=True)
        except (binascii.Error, ValueError) as error:
            raise ValueError("Selfie data is invalid") from error
        if not decoded.startswith(b"\xff\xd8"):
            raise ValueError("Selfie data is not a JPEG image")
        if not decoded.endswith(b"\xff\xd9"):
            raise ValueError("Selfie data is not a complete JPEG image")
        if len(decoded) > 144_000:
            raise ValueError("Selfie is too large")
        try:
            digest, storage_name, byte_count = selfie_archive.save(decoded)
            chat_store.save_selfie_reference(
                room_code=game.code,
                game_started_at=game.started_at,
                player_id=player.player_id,
                player_name=player.name,
                image_sha256=digest,
                storage_name=storage_name,
                byte_count=byte_count,
            )
            selfie_persistence_error_logged = False
            player.selfie_sha256 = digest
            player.selfie_storage_name = storage_name
            record_product_event(
                "selfie_uploaded",
                game=game,
                actor_type="player",
                actor_id=player.player_id,
                analytics_id=player.analytics_id,
                payload={"byte_count": byte_count},
            )
        except Exception:
            if not selfie_persistence_error_logged:
                logger.exception("Could not privately archive selfie")
                selfie_persistence_error_logged = True
            record_product_event(
                "selfie_archive_failed",
                game=game,
                actor_type="player",
                actor_id=player.player_id,
                analytics_id=player.analytics_id,
            )
        player.avatar_image = image
        emit_to_game(game.code, "lobby_update", lobby_payload(game))
    except ValueError as error:
        if game and player:
            record_product_event(
                "selfie_upload_rejected",
                game=game,
                actor_type="player",
                actor_id=player.player_id,
                analytics_id=player.analytics_id,
                payload={"reason": "validation"},
            )
        emit_validation_error(error)


@socketio.on("set_ready")
@rate_limited()
def on_set_ready(data):
    try:
        game, player = validate_caller(request.sid, require_phase=GamePhase.LOBBY)
        data = require_object(data)
        ready = data.get("ready")
        if not isinstance(ready, bool):
            raise ValueError("ready must be true or false")
        player.ready = ready
        record_product_event(
            "player_ready_changed",
            game=game,
            actor_type="player",
            actor_id=player.player_id,
            analytics_id=player.analytics_id,
            payload={"ready": ready},
        )
        emit_to_game(game.code, "lobby_update", lobby_payload(game))
    except ValueError as error:
        emit_validation_error(error)


@socketio.on("change_name")
@rate_limited()
def on_change_name(data):
    """Allow a seated player to rename only while the room is still a lobby."""
    try:
        game, player = validate_caller(request.sid, require_phase=GamePhase.LOBBY)
        data = require_object(data)
        name = require_string(data, "player_name", minimum=1, maximum=12).strip()
        if not all(character.isalnum() or character == " " for character in name):
            raise ValueError("Names may contain only letters, numbers, and spaces")
        occupied = [
            candidate.name
            for candidate in game.players.values()
            if candidate.player_id != player.player_id
        ]
        occupied.extend(spectator.name for spectator in game.spectators.values())
        if any(existing.lower() == name.lower() for existing in occupied):
            raise ValueError(f"Name '{name}' is already taken")
        player.name = name
        record_product_event(
            "player_renamed",
            game=game,
            actor_type="player",
            actor_id=player.player_id,
            analytics_id=player.analytics_id,
            payload={"name_length": len(name)},
        )
        emit("name_changed", {"player_name": player.name})
        emit_to_game(game.code, "lobby_update", lobby_payload(game))
    except ValueError as error:
        emit("name_change_failed", {"message": str(error)})


@socketio.on("update_settings")
@rate_limited()
def on_update_settings(data):
    try:
        game = validate_host(request.sid, require_phase=GamePhase.LOBBY)
        data = require_object(data)
        if "discussion_time" in data:
            discussion_time = require_integer(
                data, "discussion_time", minimum=0, maximum=900
            )
            if discussion_time != 0 and discussion_time < 60:
                raise ValueError("discussion_time must be Unlimited or at least 60 seconds")
            game.discussion_time = discussion_time
        if "proposal_time" in data:
            game.proposal_time = require_integer(
                data, "proposal_time", minimum=0, maximum=120
            )
        record_product_event(
            "settings_changed",
            game=game,
            actor_type="host_display",
            payload={
                "discussion_time": game.discussion_time,
                "proposal_time": game.proposal_time,
            },
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
        target_count = (
            require_integer(data, "target_count", minimum=6, maximum=10)
            if "target_count" in data
            else game.beta_test_player_count
        )
        game.beta_test_player_count = target_count
        game.beta_test_mode = enabled
        if enabled:
            sync_beta_bots(game, target_count)
        else:
            remove_beta_bots(game)
        record_product_event(
            "beta_test_mode_changed",
            game=game,
            actor_type="host_display",
            analytics_id=sid_to_info.get(request.sid, {}).get("analytics_id"),
            payload={"enabled": enabled, "target_count": target_count},
        )
        emit_to_game(game.code, "lobby_update", lobby_payload(game))
        persist_game(game)
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
        name_to_id = {candidate.name: candidate.player_id for candidate in game.players.values()}
        record_product_event(
            "team_preview_changed",
            game=game,
            actor_type="player",
            actor_id=player.player_id,
            analytics_id=player.analytics_id,
            payload={
                "team_ids": [name_to_id[name] for name in names],
                "team_size": len(names),
                "decision_ms": max(
                    0, int((time.time() - game.phase_started_at) * 1000)
                ),
            },
            visibility="research_secret",
        )
        emit_to_game(game.code, "team_preview", {"team_names": names})
    except ValueError as error:
        emit_validation_error(error)


@socketio.on("start_game")
@rate_limited()
def on_start_game():
    game = None
    try:
        game = validate_host(request.sid, require_phase=GamePhase.LOBBY)
        record_product_event(
            "game_start_clicked",
            game=game,
            actor_type="host_display",
            analytics_id=sid_to_info.get(request.sid, {}).get("analytics_id"),
            payload={"player_count": game.player_count()},
        )
        if prune_disconnected_lobby_players(game):
            emit_to_game(game.code, "lobby_update", lobby_payload(game))
        n = game.player_count()
        disconnected = [
            player.name
            for player in game.players.values()
            if not player.is_bot and not player.connected
        ]
        if disconnected:
            raise ValueError(
                "All players must reconnect before the game can start. Waiting for: "
                + ", ".join(disconnected)
                + "."
            )
        if game.beta_test_mode and not any(not player.is_bot for player in game.players.values()):
            raise ValueError("Join with at least one real player before testing.")
        if n < 6 or n > 10:
            raise ValueError(f"Need 6-10 players. Currently {n}.")
        assign_roles(game)
        game.started_at = time.time()
        game.game_id = str(uuid.uuid4())
        game.active_elapsed_seconds = 0.0
        game.active_since = game.started_at
        start_research_game(game)
        log_game_event(
            game,
            "game_started",
            {
                "settings": {
                    "discussion_time": game.discussion_time,
                    "proposal_time": game.proposal_time,
                },
                "players": [
                    {
                        "name": player.name,
                        "role": player.role,
                        "team": player.team,
                        "color_index": player.color_index,
                        "avatar_index": player.avatar_index,
                        "is_bot": player.is_bot,
                    }
                    for player in game.player_order_list()
                ],
            },
        )
        record_product_event(
            "game_started",
            game=game,
            actor_type="host_display",
            analytics_id=sid_to_info.get(request.sid, {}).get("analytics_id"),
            payload={
                "player_count": n,
                "discussion_time": game.discussion_time,
                "proposal_time": game.proposal_time,
                "human_count": sum(not player.is_bot for player in game.players.values()),
            },
        )
        emit_to_game(game.code, "game_starting", {"player_count": n, "game_started_at": game.started_at})
        persist_game(game)
        pause(1)
        transition_to_night_phase(game)
    except ValueError as error:
        if game:
            message = str(error)
            reason = (
                "disconnected_players" if "reconnect" in message
                else "player_count" if "Need 6-10" in message
                else "no_human_player" if "real player" in message
                else "validation"
            )
            record_product_event(
                "game_start_blocked",
                game=game,
                actor_type="host_display",
                payload={"reason": reason, "player_count": game.player_count()},
            )
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
    record_product_event(
        "night_phase_confirmed",
        game=game,
        actor_type="player",
        actor_id=player.player_id,
        analytics_id=player.analytics_id,
        payload={"decision_ms": max(0, int((time.time() - game.phase_started_at) * 1000))},
    )
    game.night_acks.add(player.player_id)
    confirmed = len(game.night_acks)
    total = game.player_count()
    emit_to_game(
        game.code,
        "night_phase_progress",
        {
            "confirmed": confirmed,
            "total": total,
            "pending_names": night_pending_names(game),
        },
    )
    if confirmed >= total:
        game.phase = GamePhase.ROUND_START  # Prevent re-entry
        emit_to_game(game.code, "night_phase_complete", {})
        persist_game(game)
        pause(1)
        start_round(game)


# --- Discussion ---


@socketio.on("set_discussion_spotlight")
@rate_limited()
def on_set_discussion_spotlight(data):
    try:
        game, leader = validate_caller(
            request.sid,
            require_phase=GamePhase.DISCUSSION,
            require_leader=True,
        )
        data = require_object(data)
        player_id = data.get("player_id")
        if player_id is not None and not isinstance(player_id, str):
            raise ValueError("player_id must be text or null")
        if player_id is not None and player_id not in game.players:
            raise ValueError("Player not found")
        game.spotlight_player_id = player_id
        target = game.players.get(player_id) if player_id else None
        record_product_event(
            "discussion_spotlight_changed",
            game=game,
            actor_type="player",
            actor_id=leader.player_id,
            analytics_id=leader.analytics_id,
            payload={
                "target_player_id": player_id,
                "cleared": player_id is None,
                "elapsed_ms": max(
                    0, int((time.time() - game.phase_started_at) * 1000)
                ),
            },
            visibility="research_secret",
        )
        emit_to_game(
            game.code,
            "discussion_spotlight",
            {
                "player_id": player_id,
                "player_name": target.name if target else None,
                "leader_name": leader.name,
            },
        )
    except ValueError as error:
        emit_validation_error(error)


@socketio.on("skip_discussion")
@rate_limited()
def on_skip_discussion(data):
    try:
        require_object(data)
        game, player = validate_caller(
            request.sid,
            require_phase=GamePhase.DISCUSSION,
            require_leader=True,
        )
        game.timer_phase_key = None
        game.timer_deadline = None
        game.timer_kind = None
        game.timer_remaining = None
        record_product_event(
            "discussion_skipped",
            game=game,
            actor_type="player",
            actor_id=player.player_id,
            analytics_id=player.analytics_id,
            payload={"elapsed_ms": max(0, int((time.time() - game.phase_started_at) * 1000))},
        )
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
        game.timer_deadline = None
        game.timer_kind = None
        game.timer_remaining = None
        record_product_event(
            "proposal_timer_skipped",
            game=game,
            actor_type="host_display",
            payload={"elapsed_ms": max(0, int((time.time() - game.phase_started_at) * 1000))},
        )
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
    record_product_event(
        "vote_submitted",
        game=game,
        actor_type="player",
        actor_id=player.player_id,
        analytics_id=player.analytics_id,
        payload={
            "choice": vote,
            "decision_ms": max(0, int((time.time() - game.phase_started_at) * 1000)),
        },
    )
    emit("vote_cast_ack", {}, room=sid)
    emit_vote_waiting(game)
    if result:
        finish_vote(game, result)


@socketio.on("confirm_vote_reveal")
@rate_limited()
def on_confirm_vote_reveal():
    try:
        game, player = validate_caller(
            request.sid,
            require_phase=GamePhase.VOTE_REVEAL,
            require_leader=True,
        )
        record_product_event(
            "vote_reveal_confirmed",
            game=game,
            actor_type="player",
            actor_id=player.player_id,
            analytics_id=player.analytics_id,
            payload={"elapsed_ms": max(0, int((time.time() - game.phase_started_at) * 1000))},
        )
        advance_after_vote(game)
    except ValueError as error:
        emit_validation_error(error)


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
    record_product_event(
        "mission_card_submitted",
        game=game,
        actor_type="player",
        actor_id=player.player_id,
        analytics_id=player.analytics_id,
        payload={
            "card": card,
            "decision_ms": max(0, int((time.time() - game.phase_started_at) * 1000)),
        },
    )
    emit("mission_card_ack", {}, room=sid)
    emit_mission_waiting(game)
    if result:
        finish_mission(game, result)


# --- Advance after mission (current leader continues) ---


def advance_after_mission(game: GameState) -> None:
    outcome = game.pending_mission_outcome
    if not outcome:
        raise ValueError("No completed mission is awaiting advancement")
    game.pending_mission_outcome = None
    if outcome == "assassin_phase":
        game.phase = GamePhase.ASSASSIN_PHASE
        mark_phase_started(game, "assassin_phase_started")
        assassin = get_assassin(game)
        public_payload = {"assassin_name": assassin.name if assassin else "Unknown"}
        emit_to_game(game.code, "assassin_phase_start", public_payload)
        if assassin and assassin.sid:
            emit_to_player(
                assassin.sid,
                "assassin_phase_start",
                {
                    **public_payload,
                    "assassin_id": assassin.player_id,
                    "targets": [
                        {"name": player.name, "player_id": player.player_id}
                        for player in get_assassin_targets(game)
                    ],
                },
            )
        run_bot_assassination(game)
    elif outcome == "evil_wins":
        game.phase = GamePhase.GAME_OVER
        emit_to_game(game.code, "game_over", get_game_summary(game))
        log_completed_game(game)
    else:
        game.current_mission += 1
        game.consecutive_rejections = 0
        game.current_leader_index = (game.current_leader_index + 1) % len(game.player_order)
        game.proposed_team = []
        game.votes = {}
        game.mission_cards = {}
        start_round(game)


@socketio.on("advance_after_mission")
@rate_limited()
def on_advance_after_mission():
    try:
        game, player = validate_caller(
            request.sid,
            require_phase=GamePhase.MISSION_REVEAL,
            require_leader=True,
        )
        record_product_event(
            "mission_reveal_confirmed",
            game=game,
            actor_type="player",
            actor_id=player.player_id,
            analytics_id=player.analytics_id,
            payload={"elapsed_ms": max(0, int((time.time() - game.phase_started_at) * 1000))},
        )
        advance_after_mission(game)
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
    decision_ms = max(0, int((time.time() - game.phase_started_at) * 1000))
    try:
        data = require_object(data)
        target_id = require_string(data, "target_player_id", minimum=32, maximum=64)
        result = process_assassination(game, target_id)
    except ValueError as e:
        emit("error", {"message": str(e)})
        return
    record_product_event(
        "assassination_submitted",
        game=game,
        actor_type="player",
        actor_id=player.player_id,
        analytics_id=player.analytics_id,
        payload={
            "decision_ms": decision_ms,
            "target_player_id": target_id,
            "was_merlin": bool(result["was_merlin"]),
        },
        visibility="research_secret",
    )
    emit_to_game(game.code, "assassination_result", result)
    log_game_event(game, "assassination", result)
    persist_game(game)
    pause(3)
    emit_to_game(game.code, "game_over", get_game_summary(game))
    log_completed_game(game)


# --- Return to lobby ---


def return_game_to_lobby(game: GameState, *, reason: str) -> None:
    record_product_event(
        "returned_to_lobby",
        game=game,
        payload={"reason": reason, "player_count": game.player_count()},
    )
    if game.started_at:
        if game.phase == GamePhase.GAME_OVER:
            finalize_research_game(game, status="completed")
        else:
            record_state_checkpoint(game, reason="returned_to_lobby_before_completion")
            finalize_research_game(
                game, status="abandoned", abandonment_reason=reason
            )
    game.reset()
    emit_to_game(
        game.code,
        "return_to_lobby",
        {
            "players": game.public_players(),
            "public_spectrum": public_spectrum_payload(game),
            "role_manifest": role_manifest(game),
            "settings": {
                "discussion_time": game.discussion_time,
                "proposal_time": game.proposal_time,
                "beta_test_mode": game.beta_test_mode,
                "beta_test_player_count": game.beta_test_player_count,
            },
        },
    )


def rematch_status_payload(game: GameState) -> dict:
    eligible = [player for player in game.player_order_list() if not player.is_bot]
    return {
        "ready_ids": sorted(game.rematch_ready),
        "ready_names": [
            player.name for player in eligible if player.player_id in game.rematch_ready
        ],
        "ready_count": sum(
            player.player_id in game.rematch_ready for player in eligible
        ),
        "total_count": len(eligible),
    }


@socketio.on("set_rematch_ready")
@rate_limited()
def on_set_rematch_ready(data):
    try:
        game, player = validate_caller(request.sid, require_phase=GamePhase.GAME_OVER)
        if player.is_bot:
            raise ValueError("Bot players cannot request a rematch")
        data = require_object(data)
        ready = data.get("ready")
        if not isinstance(ready, bool):
            raise ValueError("ready must be true or false")
        if ready:
            game.rematch_ready.add(player.player_id)
        else:
            game.rematch_ready.discard(player.player_id)
        record_product_event(
            "rematch_ready_changed",
            game=game,
            actor_type="player",
            actor_id=player.player_id,
            analytics_id=player.analytics_id,
            payload={"ready": ready},
        )
        status = rematch_status_payload(game)
        emit_to_game(game.code, "rematch_status", status)
        if status["total_count"] and status["ready_count"] == status["total_count"]:
            return_game_to_lobby(game, reason="unanimous_rematch")
    except ValueError as error:
        emit_validation_error(error)


@socketio.on("return_to_lobby")
@rate_limited()
def on_return_to_lobby():
    try:
        game = validate_host(request.sid)
        return_game_to_lobby(game, reason="host_return")
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
    global chat_persistence_error_logged
    sid = request.sid
    info = sid_to_info.get(sid)
    if not info:
        return
    game = games.get(info.get("game_code"))
    if not game or game.phase == GamePhase.LOBBY:
        return
    player = game.players.get(info.get("player_id")) if info.get("player_id") else None
    spectator = (
        game.spectators.get(info.get("spectator_id"))
        if info.get("spectator_id")
        else None
    )
    participant = player or spectator
    if not participant:
        return
    try:
        data = require_object(data)
        msg = require_string(data, "message", minimum=1, maximum=500)
    except ValueError as error:
        emit_validation_error(error)
        return
    created_at = datetime.now(timezone.utc)
    timestamp = created_at.isoformat(timespec="seconds").replace("+00:00", "Z")
    message_id = str(uuid.uuid4())
    participant_analytics_id = participant.analytics_id
    try:
        chat_store.save(
            room_code=game.code,
            game_started_at=game.started_at,
            player_name=participant.name,
            message=msg,
            message_id=message_id,
            party_id=game.party_id,
            game_id=game.game_id,
            actor_type="spectator" if spectator else "player",
            actor_id=spectator.spectator_id if spectator else player.player_id,
            subject_id=research_subject_id(participant_analytics_id),
            phase=game.phase.value,
            mission_num=(game.current_mission + 1) if game.started_at else None,
            proposal_attempt=(
                game.consecutive_rejections + 1 if game.started_at else None
            ),
            created_at=created_at,
        )
        chat_persistence_error_logged = False
    except Exception:
        # Chat should remain usable if storage is temporarily unavailable. Log
        # only the first consecutive failure, without including message text.
        if not chat_persistence_error_logged:
            logger.exception("Could not persist chat message")
            chat_persistence_error_logged = True
    emit_to_game(
        game.code,
        "chat_message",
        {
            "name": participant.name,
            "message": msg,
            "color_index": participant.color_index,
            "is_spectator": spectator is not None,
            "timestamp": timestamp,
        },
    )
    record_product_event(
        "chat_sent",
        game=game,
        actor_type="spectator" if spectator else "player",
        actor_id=(spectator.spectator_id if spectator else player.player_id),
        analytics_id=participant_analytics_id,
        payload={
            "message_id": message_id,
            "message_length": len(msg),
            "word_count": len(msg.split()),
            "contains_url": "http://" in msg.lower() or "https://" in msg.lower(),
            "is_spectator": spectator is not None,
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


load_persisted_games()


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
