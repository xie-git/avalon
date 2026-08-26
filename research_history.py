"""Inspect, validate, export, and summarize Avalon research data.

The default commands are read-only.  Export/dataset commands only write the
explicit output path supplied by the operator.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from statistics import mean
from typing import Any, Iterable

from chat_store import ChatStore, configured_chat_store
from research_telemetry import (
    REPLAY_SPEC,
    REPLAY_SPEC_VERSION,
    RESEARCH_SPEC,
    RESEARCH_SPEC_VERSION,
    RULESET_VERSION,
    canonical_json,
    chained_event_hash,
    pseudonymous_subject_id,
    sha256_json,
    utc_timestamp,
)


BUNDLE_SPEC = "avalon.research.bundle"
BUNDLE_SPEC_VERSION = "1.0.0"
DATASET_SPEC = "avalon.research.dataset"


JSON_COLUMNS = {
    "settings_json": "settings",
    "role_set_json": "role_set",
    "initial_state_json": "initial_state",
    "final_state_json": "final_state",
}


def row_dict(row) -> dict:
    return dict(row) if row is not None else {}


def decoded_game(row) -> dict:
    result = row_dict(row)
    for column, target in JSON_COLUMNS.items():
        raw = result.pop(column, None)
        result[target] = json.loads(raw) if raw else None
    return result


def decoded_event(row, *, include_state: bool = True) -> dict:
    result = json.loads(row["event_json"])
    result["integrity"]["event_hash"] = row["event_hash"]
    if include_state and row["state_json"]:
        result["checkpoint"]["state"] = json.loads(row["state_json"])
    return result


def decoded_client_session(row) -> dict:
    result = row_dict(row)
    result["initial_context"] = json.loads(result.pop("initial_context_json") or "{}")
    return result


NAME_VALUE_FIELDS = {
    "display_name",
    "player_name",
    "leader_name",
    "target_name",
    "assassin_name",
    "name",
}
NAME_LIST_FIELDS = {
    "team",
    "player_order",
    "sees",
    "voted",
    "remaining",
    "played_players",
    "remaining_players",
    "pending_names",
}
NAME_KEYED_FIELDS = {"roles", "votes", "cards_by_player"}


def _replace_private_values(
    value: Any, mapping: dict[str, str], *, parent_key: str | None = None
) -> Any:
    if isinstance(value, list):
        return [
            mapping.get(item, item)
            if parent_key in NAME_LIST_FIELDS and isinstance(item, str)
            else _replace_private_values(item, mapping, parent_key=parent_key)
            for item in value
        ]
    if isinstance(value, dict):
        cleaned = {}
        for key, item in value.items():
            mapped_key = (
                mapping.get(str(key), key)
                if parent_key in NAME_KEYED_FIELDS
                else key
            )
            if key in {"subject_id", "selfie_sha256"}:
                cleaned[key] = None
            elif key == "room_code":
                cleaned[key] = "REDACTED"
            elif key in NAME_VALUE_FIELDS and isinstance(item, str):
                cleaned[mapped_key] = mapping.get(item, item)
            else:
                cleaned[mapped_key] = _replace_private_values(
                    item, mapping, parent_key=str(key)
                )
        return cleaned
    return value


def redact_bundle(bundle: dict) -> dict:
    participants = bundle.get("participants", [])
    name_map = {}
    player_number = 0
    spectator_number = 0
    for participant in participants:
        if participant["participant_type"] == "player":
            player_number += 1
            replacement = f"Player {player_number}"
        else:
            spectator_number += 1
            replacement = f"Spectator {spectator_number}"
        name_map[participant["display_name"]] = replacement
    redacted = _replace_private_values(bundle, name_map)
    for participant in redacted.get("participants", []):
        participant["subject_id"] = None
        participant["selfie_sha256"] = None
    for message in redacted.get("chat", []):
        message["message"] = "[redacted]"
        message["subject_id"] = None
    redacted["manifest"]["redacted"] = True
    return redacted


def build_bundle(
    store: ChatStore,
    game_id: str,
    *,
    include_chat: bool = False,
    include_checkpoints: bool = True,
    redact: bool = False,
) -> dict:
    game_row = store.research_game(game_id)
    if not game_row:
        raise ValueError(f"research game not found: {game_id}")
    event_rows = store.research_events(game_id=game_id)
    game = decoded_game(game_row)
    party_rows = [
        row
        for row in store.research_events(stream_id=game["party_id"])
        if row["occurred_at"] <= game["started_at"]
    ]
    participants = [row_dict(row) for row in store.research_participants(game_id)]
    client_sessions = [
        decoded_client_session(row)
        for row in store.research_client_sessions(game_id=game_id)
    ]
    stream = row_dict(store.research_stream(game_id))
    bundle = {
        "manifest": {
            "spec": BUNDLE_SPEC,
            "spec_version": BUNDLE_SPEC_VERSION,
            "event_spec": RESEARCH_SPEC,
            "event_spec_version": RESEARCH_SPEC_VERSION,
            "replay_spec": REPLAY_SPEC,
            "replay_spec_version": REPLAY_SPEC_VERSION,
            "ruleset_version": RULESET_VERSION,
            "exported_at": utc_timestamp(),
            "redacted": False,
            "includes_chat_content": include_chat,
            "includes_checkpoints": include_checkpoints,
            "event_count": len(event_rows),
            "party_event_count": len(party_rows),
            "checkpoint_count": sum(bool(row["state_json"]) for row in event_rows),
            "last_event_hash": stream.get("last_event_hash"),
        },
        "game": game,
        "participants": participants,
        "client_sessions": client_sessions,
        "party_timeline": [decoded_event(row) for row in party_rows],
        "timeline": [
            decoded_event(row, include_state=include_checkpoints) for row in event_rows
        ],
    }
    if include_chat:
        bundle["chat"] = [
            row_dict(row) for row in store.research_chat_messages(game_id)
        ]
    return redact_bundle(bundle) if redact else bundle


def validate_stream(store: ChatStore, stream_id: str) -> dict:
    rows = store.research_events(stream_id=stream_id)
    stream = store.research_stream(stream_id)
    errors = []
    previous_hash = None
    checkpoint_count = 0
    for expected_sequence, row in enumerate(rows, start=1):
        if row["sequence_no"] != expected_sequence:
            errors.append(
                f"sequence {row['sequence_no']} encountered; expected {expected_sequence}"
            )
        try:
            document = json.loads(row["event_json"])
        except json.JSONDecodeError as error:
            errors.append(f"sequence {row['sequence_no']} has invalid JSON: {error}")
            continue
        documented_previous = document.get("integrity", {}).get(
            "previous_event_hash"
        )
        if documented_previous != previous_hash or row["previous_event_hash"] != previous_hash:
            errors.append(f"sequence {row['sequence_no']} breaks the previous-hash chain")
        calculated_hash = chained_event_hash(document)
        if calculated_hash != row["event_hash"]:
            errors.append(f"sequence {row['sequence_no']} has an invalid event hash")
        if row["state_json"]:
            checkpoint_count += 1
            try:
                state = json.loads(row["state_json"])
                calculated_state_hash = sha256_json(state)
            except (json.JSONDecodeError, ValueError) as error:
                errors.append(
                    f"sequence {row['sequence_no']} has invalid state JSON: {error}"
                )
            else:
                if calculated_state_hash != row["state_hash"]:
                    errors.append(
                        f"sequence {row['sequence_no']} has an invalid state hash"
                    )
                if document.get("checkpoint", {}).get("state_hash") != row["state_hash"]:
                    errors.append(
                        f"sequence {row['sequence_no']} documents the wrong state hash"
                    )
        previous_hash = row["event_hash"]
    if not stream:
        errors.append("stream metadata is missing")
    else:
        if stream["event_count"] != len(rows):
            errors.append("stream event_count does not match stored rows")
        if rows and stream["last_event_hash"] != rows[-1]["event_hash"]:
            errors.append("stream last_event_hash does not match the timeline")
        if stream["next_sequence_no"] != len(rows) + 1:
            errors.append("stream next_sequence_no is inconsistent")
    return {
        "stream_id": stream_id,
        "valid": not errors,
        "event_count": len(rows),
        "checkpoint_count": checkpoint_count,
        "last_event_hash": previous_hash,
        "errors": errors,
    }


def _event_data(row) -> dict:
    try:
        return json.loads(row["payload_json"])
    except (TypeError, json.JSONDecodeError):
        return {}


def _average(values: Iterable[int | float]) -> int | None:
    values = list(values)
    return round(mean(values)) if values else None


def _percentage(numerator: int, denominator: int) -> float | None:
    return round(numerator * 100 / denominator, 1) if denominator else None


def build_wrapped(
    store: ChatStore, subject_id: str, *, year: int | None = None
) -> dict:
    subject_rows = [
        row_dict(row)
        for row in store.research_participants(subject_id=subject_id)
        if row["participant_type"] == "player"
    ]
    games_by_id = {
        row["game_id"]: decoded_game(row) for row in store.research_games(limit=100000)
    }
    appearances = []
    for participant in subject_rows:
        game = games_by_id.get(participant["game_id"])
        if not game:
            continue
        started = datetime.fromtimestamp(game["started_at_unix"], timezone.utc)
        if year is not None and started.year != year:
            continue
        appearances.append((participant, game, started))
    if not appearances:
        raise ValueError("no research games found for that subject and period")

    completed = [(p, g, dt) for p, g, dt in appearances if g["status"] == "completed"]
    roles = Counter(p["role"] or "Unknown" for p, _, _ in completed)
    alignments = Counter(p["team"] or "unknown" for p, _, _ in completed)
    wins = sum(bool(p["won"]) for p, _, _ in completed)
    days = Counter(dt.strftime("%A") for _, _, dt in appearances)
    hours = Counter(dt.hour for _, _, dt in appearances)
    subject_events = [
        row
        for row in store.research_events(subject_id=subject_id, limit=1_000_000)
        if year is None or row["occurred_at"].startswith(f"{year:04d}-")
    ]
    event_counts = Counter(row["event_type"] for row in subject_events)
    screen_views = Counter()
    control_uses = Counter()
    rematch_yes = 0
    for row in subject_events:
        data = _event_data(row)
        if row["event_type"] == "screen_viewed" and data.get("screen_id"):
            screen_views[data["screen_id"]] += 1
        elif row["event_type"] == "ui_control_activated" and data.get("control_id"):
            control_uses[data["control_id"]] += 1
        elif row["event_type"] == "rematch_ready_changed" and data.get("ready"):
            rematch_yes += 1
    vote_choices = Counter()
    mission_cards = Counter()
    proposal_decisions = []
    vote_decisions = []
    mission_decisions = []
    assassination_decisions = []
    leadership_proposals = 0
    approved_leadership_proposals = 0
    team_selections_received = 0
    spotlight_received = 0
    chat_messages = event_counts["chat_sent"]
    disconnects = event_counts["player_disconnected"]
    reconnects = event_counts["player_reconnected"]
    help_opens = event_counts["help_opened"]
    role_card_opens = event_counts["role_card_opened"]
    quest_appearances = 0
    assassination_attempts = 0
    assassination_hits = 0
    co_players = Counter()
    per_game_details = []

    for participant, game, started in appearances:
        player_id = participant["participant_id"]
        events = store.research_events(game_id=game["game_id"])
        pending_leader_id = None
        quests_this_game = 0
        for row in events:
            data = _event_data(row)
            event_type = row["event_type"]
            if row["actor_id"] == player_id:
                if event_type == "vote_submitted":
                    vote_choices[data.get("choice", "unknown")] += 1
                    if isinstance(data.get("decision_ms"), int):
                        vote_decisions.append(data["decision_ms"])
                elif event_type == "mission_card_submitted":
                    mission_cards[data.get("card", "unknown")] += 1
                    quest_appearances += 1
                    quests_this_game += 1
                    if isinstance(data.get("decision_ms"), int):
                        mission_decisions.append(data["decision_ms"])
                elif event_type == "team_proposal_submitted":
                    leadership_proposals += 1
                    pending_leader_id = player_id
                    if isinstance(data.get("decision_ms"), int):
                        proposal_decisions.append(data["decision_ms"])
                elif event_type == "assassination_submitted":
                    assassination_attempts += 1
                    assassination_hits += int(bool(data.get("was_merlin")))
                    if isinstance(data.get("decision_ms"), int):
                        assassination_decisions.append(data["decision_ms"])
            if event_type == "team_proposal_submitted":
                pending_leader_id = row["actor_id"]
                if player_id in data.get("team_ids", []):
                    team_selections_received += 1
            elif event_type == "team_vote" and pending_leader_id == player_id:
                approved_leadership_proposals += int(bool(data.get("approved")))
                pending_leader_id = None
            elif event_type == "discussion_spotlight_changed":
                spotlight_received += int(data.get("target_player_id") == player_id)
        others = store.research_participants(game["game_id"])
        for other in others:
            if (
                other["participant_type"] == "player"
                and other["participant_id"] != player_id
                and other["subject_id"]
            ):
                co_players[other["subject_id"]] += 1
        per_game_details.append(
            {
                "game_id": game["game_id"],
                "started_at": game["started_at"],
                "status": game["status"],
                "role": participant["role"],
                "team": participant["team"],
                "won": bool(participant["won"]) if participant["won"] is not None else None,
                "active_duration_ms": game["active_duration_ms"],
                "quests_played": quests_this_game,
            }
        )

    latest_name = max(appearances, key=lambda item: item[2])[0]["display_name"]
    completed_count = len(completed)
    approval_total = sum(vote_choices.values())
    total_active_ms = sum(
        int(game.get("active_duration_ms") or 0) for _, game, _ in appearances
    )
    longest = max(
        appearances,
        key=lambda item: int(item[1].get("active_duration_ms") or 0),
    )[1]
    favorite_role, favorite_role_count = roles.most_common(1)[0] if roles else (None, 0)
    favorite_day = days.most_common(1)[0][0] if days else None
    favorite_hour = hours.most_common(1)[0][0] if hours else None
    most_frequent_ally = co_players.most_common(1)[0] if co_players else (None, 0)
    wrapped = {
        "spec": "avalon.wrapped",
        "spec_version": "1.0.0",
        "generated_at": utc_timestamp(),
        "period": {"year": year, "label": str(year) if year else "all-time"},
        "subject": {
            "subject_id": subject_id,
            "latest_display_name": latest_name,
        },
        "headline": {
            "games_started": len(appearances),
            "games_completed": completed_count,
            "wins": wins,
            "losses": completed_count - wins,
            "win_rate_percent": _percentage(wins, completed_count),
            "active_time_ms": total_active_ms,
        },
        "identity": {
            "roles": dict(roles.most_common()),
            "alignments": dict(alignments.most_common()),
            "favorite_role": favorite_role,
            "favorite_role_games": favorite_role_count,
        },
        "table_style": {
            "votes": dict(vote_choices),
            "approval_rate_percent": _percentage(
                vote_choices["approve"], approval_total
            ),
            "average_vote_decision_ms": _average(vote_decisions),
            "leadership_proposals": leadership_proposals,
            "leadership_approval_rate_percent": _percentage(
                approved_leadership_proposals, leadership_proposals
            ),
            "average_proposal_decision_ms": _average(proposal_decisions),
            "times_selected_for_quest": team_selections_received,
            "times_spotlighted": spotlight_received,
        },
        "quests": {
            "quests_played": quest_appearances,
            "cards": dict(mission_cards),
            "fail_card_rate_percent": _percentage(
                mission_cards["fail"], sum(mission_cards.values())
            ),
            "average_card_decision_ms": _average(mission_decisions),
        },
        "assassination": {
            "attempts": assassination_attempts,
            "merlins_found": assassination_hits,
            "accuracy_percent": _percentage(assassination_hits, assassination_attempts),
            "average_decision_ms": _average(assassination_decisions),
        },
        "social_and_app": {
            "chat_messages": chat_messages,
            "disconnects": disconnects,
            "reconnects": reconnects,
            "help_opens": help_opens,
            "role_card_opens": role_card_opens,
            "rematch_ready_yes": rematch_yes,
            "client_sessions": len(
                {row["client_session_id"] for row in subject_events if row["client_session_id"]}
            ),
            "client_errors": event_counts["client_error"],
            "screens_viewed": dict(screen_views.most_common()),
            "controls_used": dict(control_uses.most_common()),
            "favorite_play_day_utc": favorite_day,
            "favorite_start_hour_utc": favorite_hour,
            "most_frequent_ally_subject_id": most_frequent_ally[0],
            "games_with_most_frequent_ally": most_frequent_ally[1],
        },
        "records": {
            "longest_game_id": longest["game_id"],
            "longest_game_active_ms": longest.get("active_duration_ms"),
        },
        "event_counts": dict(event_counts.most_common()),
        "games": per_game_details,
    }
    wrapped["cards"] = [
        {
            "id": "games",
            "headline": str(len(appearances)),
            "label": "games entered",
        },
        {
            "id": "win_rate",
            "headline": (
                f"{wrapped['headline']['win_rate_percent']}%"
                if wrapped["headline"]["win_rate_percent"] is not None
                else "—"
            ),
            "label": "win rate",
        },
        {
            "id": "favorite_role",
            "headline": favorite_role or "Unknown",
            "label": "most-played role",
        },
        {
            "id": "voting_style",
            "headline": (
                f"{wrapped['table_style']['approval_rate_percent']}% approve"
                if wrapped["table_style"]["approval_rate_percent"] is not None
                else "No votes yet"
            ),
            "label": "fellowship voting style",
        },
        {
            "id": "questing",
            "headline": str(quest_appearances),
            "label": "quests joined",
        },
    ]
    return wrapped


def write_json(value: Any, output: str, *, force: bool = False) -> None:
    text = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if output == "-":
        sys.stdout.write(text)
        return
    path = Path(output)
    if path.exists() and not force:
        raise ValueError(f"refusing to overwrite existing file: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def cmd_list(store: ChatStore, args) -> None:
    for row in store.research_games(status=args.status, limit=args.limit):
        print(
            f"{row['game_id']}  {row['started_at']}  {row['status']:<11}  "
            f"{row['player_count']} players  {row['winner'] or '-'}"
        )


def cmd_export(store: ChatStore, args) -> None:
    bundle = build_bundle(
        store,
        args.game_id,
        include_chat=args.include_chat,
        include_checkpoints=not args.no_checkpoints,
        redact=args.redact,
    )
    write_json(bundle, args.output, force=args.force)


def cmd_validate(store: ChatStore, args) -> None:
    result = validate_stream(store, args.stream_id)
    print(json.dumps(result, indent=2, sort_keys=True))
    if not result["valid"]:
        raise SystemExit(1)


def cmd_wrapped(store: ChatStore, args) -> None:
    subject_id = args.subject_id
    if args.analytics_id:
        key = (
            os.environ.get("ANALYTICS_PSEUDONYM_KEY")
            or os.environ.get("SECRET_KEY")
            or "avalon-development-research-subjects"
        )
        subject_id = pseudonymous_subject_id(args.analytics_id, key)
    value = build_wrapped(store, subject_id, year=args.year)
    write_json(value, args.output, force=args.force)


def cmd_dataset(store: ChatStore, args) -> None:
    path = Path(args.output)
    if path.exists() and not args.force:
        raise ValueError(f"refusing to overwrite existing file: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    games = list(reversed(store.research_games(status=args.status, limit=args.limit)))
    with path.open("w", encoding="utf-8") as output:
        header = {
            "spec": DATASET_SPEC,
            "spec_version": "1.0.0",
            "record_type": "manifest",
            "generated_at": utc_timestamp(),
            "game_count": len(games),
            "redacted": args.redact,
            "includes_chat_content": args.include_chat,
        }
        output.write(canonical_json(header) + "\n")
        for row in games:
            bundle = build_bundle(
                store,
                row["game_id"],
                include_chat=args.include_chat,
                include_checkpoints=not args.no_checkpoints,
                redact=args.redact,
            )
            output.write(canonical_json({"record_type": "game", "bundle": bundle}) + "\n")


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(
        description="Private replay, research dataset, and Avalon Wrapped tooling"
    )
    commands = root.add_subparsers(dest="command", required=True)

    list_parser = commands.add_parser("list", help="list normalized games")
    list_parser.add_argument(
        "--status", choices=("in_progress", "completed", "abandoned", "expired")
    )
    list_parser.add_argument("--limit", type=int, default=1000)
    list_parser.set_defaults(function=cmd_list)

    export_parser = commands.add_parser("export", help="export one replay bundle")
    export_parser.add_argument("game_id")
    export_parser.add_argument("--output", "-o", default="-")
    export_parser.add_argument("--include-chat", action="store_true")
    export_parser.add_argument("--no-checkpoints", action="store_true")
    export_parser.add_argument("--redact", action="store_true")
    export_parser.add_argument("--force", action="store_true")
    export_parser.set_defaults(function=cmd_export)

    validate_parser = commands.add_parser(
        "validate", help="verify sequence, event hashes, and checkpoint hashes"
    )
    validate_parser.add_argument("stream_id")
    validate_parser.set_defaults(function=cmd_validate)

    wrapped_parser = commands.add_parser(
        "wrapped", help="build visualization-ready per-player aggregates"
    )
    identity = wrapped_parser.add_mutually_exclusive_group(required=True)
    identity.add_argument("--subject-id")
    identity.add_argument("--analytics-id")
    wrapped_parser.add_argument("--year", type=int)
    wrapped_parser.add_argument("--output", "-o", default="-")
    wrapped_parser.add_argument("--force", action="store_true")
    wrapped_parser.set_defaults(function=cmd_wrapped)

    dataset_parser = commands.add_parser(
        "dataset", help="export newline-delimited game bundles for analysis/AI"
    )
    dataset_parser.add_argument("--output", "-o", required=True)
    dataset_parser.add_argument(
        "--status",
        choices=("in_progress", "completed", "abandoned", "expired"),
        default="completed",
    )
    dataset_parser.add_argument("--limit", type=int, default=100000)
    dataset_parser.add_argument("--include-chat", action="store_true")
    dataset_parser.add_argument("--no-checkpoints", action="store_true")
    dataset_parser.add_argument("--redact", action="store_true")
    dataset_parser.add_argument("--force", action="store_true")
    dataset_parser.set_defaults(function=cmd_dataset)
    return root


def main() -> None:
    args = parser().parse_args()
    store = configured_chat_store()
    store.initialize()
    try:
        args.function(store, args)
    except ValueError as error:
        raise SystemExit(str(error)) from error


if __name__ == "__main__":
    main()
