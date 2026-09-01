"""Canonical, privacy-bounded research records for Avalon.

This module deliberately has no Flask or storage dependencies.  It owns the
portable replay-state representation and the hash-chain format used by the
SQLite store and offline exporters.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import math
import time
from datetime import datetime, timezone
from enum import Enum
from typing import Any


RESEARCH_SPEC = "avalon.research.event"
RESEARCH_SPEC_VERSION = "1.0.0"
REPLAY_SPEC = "avalon.replay.state"
REPLAY_SPEC_VERSION = "1.0.0"
RULESET_VERSION = "avalon-base-6-10@2"
MAX_RESEARCH_PAYLOAD_BYTES = 64 * 1024
MAX_REPLAY_STATE_BYTES = 256 * 1024


def utc_timestamp(timestamp: datetime | None = None) -> str:
    value = timestamp or datetime.now(timezone.utc)
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def canonical_json(value: Any) -> str:
    """Return the one canonical JSON encoding used for hashes and exports."""
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def sha256_json(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def pseudonymous_subject_id(analytics_id: str | None, key: str) -> str | None:
    """Create a stable, non-reversible cross-game research subject ID."""
    if not analytics_id:
        return None
    digest = hmac.new(
        key.encode("utf-8"), analytics_id.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return f"subject_{digest[:32]}"


def scalar(value: Any) -> Any:
    if isinstance(value, Enum):
        return value.value
    return value


def _finite_number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) else None


def _remaining_timer(game: Any) -> int | None:
    if game.timer_remaining is None:
        return None
    return max(0, int(game.timer_remaining))


def replay_state(game: Any, *, captured_at: float | None = None) -> dict[str, Any]:
    """Build a capability-free authoritative state sufficient for exact replay.

    The snapshot intentionally includes hidden roles, individual votes/cards,
    and stable seat IDs because it is a private
    research artifact.  Raw/hashed auth capabilities, socket IDs, IP data, and
    embedded selfie bytes are never included.
    """
    # ``captured_at`` remains an explicit API argument for callers that align
    # checkpoint and event timestamps.  Derived ticking values are not baked
    # into the state: authoritative start/deadline fields let a replay compute
    # them at any event time and allow identical states to deduplicate.
    _ = float(captured_at if captured_at is not None else time.time())
    ordered_ids = [pid for pid in game.player_order if pid in game.players]
    players = []
    for seat_index, player_id in enumerate(ordered_ids):
        player = game.players[player_id]
        players.append(
            {
                "player_id": player.player_id,
                "display_name": player.name,
                "seat_index": seat_index,
                "role": scalar(player.role),
                "team": scalar(player.team),
                "is_bot": bool(player.is_bot),
                "is_host_player": player.player_id == game.host_player_id,
                "connected": bool(player.connected),
                "ready": bool(player.ready),
                "color_index": int(player.color_index),
                "avatar_index": int(player.avatar_index),
                "avatar_source": "selfie" if player.selfie_sha256 else "built_in",
                "selfie_sha256": player.selfie_sha256,
            }
        )
    spectators = [
        {
            "spectator_id": spectator.spectator_id,
            "display_name": spectator.name,
            "connected": bool(spectator.connected),
            "color_index": int(spectator.color_index),
            "vision_mode": spectator.vision_mode,
        }
        for spectator in sorted(
            game.spectators.values(), key=lambda item: item.spectator_id
        )
    ]
    leader = game.current_leader()
    state = {
        "spec": REPLAY_SPEC,
        "spec_version": REPLAY_SPEC_VERSION,
        "ruleset_version": RULESET_VERSION,
        "identity": {
            "party_id": game.party_id,
            "game_id": game.game_id,
            "room_code": game.code,
        },
        "clock": {
            "game_started_at_unix": _finite_number(game.started_at),
            "phase_started_at_unix": _finite_number(game.phase_started_at),
            "active_elapsed_ms": max(
                0, round(float(game.active_elapsed_seconds) * 1000)
            ),
            "active_since_unix": _finite_number(game.active_since),
        },
        "settings": {
            "discussion_seconds": int(game.discussion_time),
            "proposal_seconds": int(game.proposal_time),
            "beta_test_mode": bool(game.beta_test_mode),
            "beta_test_player_count": int(game.beta_test_player_count),
        },
        "lifecycle": {
            "phase": scalar(game.phase),
            "suspended": bool(game.suspended),
            "inactive_since_unix": _finite_number(game.inactive_since),
            "expires_at_unix": _finite_number(game.expires_at),
        },
        "roster": {
            "players": players,
            "spectators": spectators,
            "player_order": ordered_ids,
        },
        "progress": {
            "mission_number": int(game.current_mission) + 1,
            "leader_index": int(game.current_leader_index),
            "leader_id": leader.player_id if leader else None,
            "mission_results": list(game.mission_results),
            "consecutive_rejections": int(game.consecutive_rejections),
            "mission_history": list(game.mission_history),
            "proposal_history": list(game.proposal_history),
        },
        "private_action_state": {
            "proposed_team_ids": list(game.proposed_team),
            "votes_by_player_id": dict(sorted(game.votes.items())),
            "pending_vote_result": game.pending_vote_result,
            "mission_cards_by_player_id": dict(sorted(game.mission_cards.items())),
            "night_ack_player_ids": sorted(game.night_acks),
            "pending_mission_outcome": game.pending_mission_outcome,
        },
        "timer": {
            "kind": game.timer_kind,
            "remaining_seconds": _remaining_timer(game),
            "deadline_unix": _finite_number(game.timer_deadline),
        },
        "outcome": {
            "winner": game.winner,
            "win_reason": game.win_reason,
            "assassin_target_player_id": game.assassin_target,
        },
        "social": {
            "rematch_ready_player_ids": sorted(game.rematch_ready),
        },
    }
    encoded = canonical_json(state).encode("utf-8")
    if len(encoded) > MAX_REPLAY_STATE_BYTES:
        raise ValueError(
            f"replay state exceeds {MAX_REPLAY_STATE_BYTES} bytes"
        )
    return state


def classify_event(event_type: str, source: str) -> str:
    """Apply a stable top-level category without coupling callers to a map."""
    if source == "state_checkpoint":
        return "state"
    if any(word in event_type for word in ("error", "failed", "blocked", "rejected")):
        return "reliability"
    if any(word in event_type for word in ("connect", "resume", "suspend", "session")):
        return "connectivity"
    if event_type.startswith(("room_", "game_", "returned_", "rematch_")):
        return "lifecycle"
    if event_type.startswith(("player_join", "spectator_join", "settings_", "avatar_", "selfie_", "player_ready", "player_renamed", "roster_", "beta_")):
        return "lobby"
    if event_type.startswith("chat_"):
        return "social"
    if event_type.startswith(
        (
            "client_",
            "screen_",
            "help_",
            "role_card_",
            "victory_screen",
            "entry_",
            "page_",
            "visibility_",
            "wake_lock_",
            "ui_",
        )
    ):
        return "experience"
    if source == "gameplay" or event_type.startswith(
        ("round_", "night_", "discussion_", "proposal_", "team_", "vote_", "mission_", "assassin")
    ):
        return "gameplay"
    return "product"


def build_event_document(
    *,
    event_id: str,
    stream_id: str,
    stream_type: str,
    sequence_no: int,
    occurred_at: str,
    recorded_at: str,
    app_version: str,
    party_id: str | None,
    room_code: str | None,
    game_id: str | None,
    source: str,
    category: str,
    event_type: str,
    visibility: str,
    actor_type: str,
    actor_id: str | None,
    subject_id: str | None,
    phase: str | None,
    mission_num: int | None,
    proposal_attempt: int | None,
    game_elapsed_ms: int | None,
    phase_elapsed_ms: int | None,
    payload: dict[str, Any],
    state_hash: str | None,
    previous_event_hash: str | None,
    client: dict[str, Any] | None = None,
) -> dict[str, Any]:
    document = {
        "spec": RESEARCH_SPEC,
        "spec_version": RESEARCH_SPEC_VERSION,
        "event_id": event_id,
        "stream": {
            "id": stream_id,
            "type": stream_type,
            "sequence": int(sequence_no),
        },
        "time": {
            "occurred_at": occurred_at,
            "recorded_at": recorded_at,
            "game_elapsed_ms": game_elapsed_ms,
            "phase_elapsed_ms": phase_elapsed_ms,
        },
        "application": {
            "version": app_version,
            "ruleset_version": RULESET_VERSION,
        },
        "context": {
            "party_id": party_id,
            "room_code": room_code,
            "game_id": game_id,
            "phase": phase,
            "mission_number": mission_num,
            "proposal_attempt": proposal_attempt,
        },
        "event": {
            "source": source,
            "category": category,
            "name": event_type,
            "visibility": visibility,
        },
        "actor": {
            "type": actor_type,
            "id": actor_id,
            "subject_id": subject_id,
        },
        "data": payload,
        "checkpoint": {"state_hash": state_hash} if state_hash else None,
        "integrity": {"previous_event_hash": previous_event_hash},
    }
    if client:
        document["client"] = client
    return document


def chained_event_hash(event_document: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_json(event_document).encode("utf-8")).hexdigest()
