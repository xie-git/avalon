import random

import pytest

import server
from game_logic import GamePhase, GameState, add_player
from narrator import (
    COPY_BANKS,
    DIRECT_LIMIT_PER_MISSION,
    PublicNarratorState,
    TRIGGERS,
    choose_proactive,
    direct_reply,
    drain_pending,
    final_word,
    mission_candidates,
    new_runtime,
    should_speak,
    validate_public_payload,
    vote_candidates,
)


class AlwaysDoubleRandom(random.Random):
    """Stable selector whose rarity roll always elects the second beat."""

    def random(self):
        return 0.0


class MidpointRandom:
    def uniform(self, low, high):
        return (low + high) / 2


def public_state(**changes):
    values = {
        "mission_num": 1,
        "player_count": 6,
        "player_names": ("Arthur", "Gwen", "Merlin", "Morgana", "Percival", "Lance"),
        "leader_name": "Arthur",
        "mission_results": (),
        "mission_history": (),
        "proposal_history": (),
        "proposed_team": ("Arthur", "Gwen"),
        "consecutive_rejections": 0,
        "discussion_seconds": 60,
        "phase_elapsed_seconds": 0,
    }
    values.update(changes)
    return PublicNarratorState(**values)


def test_all_94_situations_have_twenty_distinct_authored_lines():
    assert set(TRIGGERS) == set(range(1, 95))
    assert set(COPY_BANKS) == set(TRIGGERS)
    assert all(len(bank) == 20 and len(set(bank)) == 20 for bank in COPY_BANKS.values())


def test_proactive_limit_allows_only_exceptional_second_message():
    runtime = new_runtime()
    first = choose_proactive(runtime, [40], mission_num=2, rng=random.Random(1))
    assert first
    assert choose_proactive(runtime, [41], mission_num=2, rng=random.Random(2)) is None
    second = choose_proactive(runtime, [43], mission_num=2, rng=random.Random(3))
    assert second
    assert choose_proactive(runtime, [55], mission_num=2, rng=random.Random(4)) is None
    assert runtime["proactive_counts"]["2"] == 2


def test_rare_double_act_is_coherent_and_atomically_consumes_both_slots():
    runtime = new_runtime()
    first = choose_proactive(
        runtime, [23], mission_num=3, rng=AlwaysDoubleRandom()
    )

    assert first["double_act_part"] == 1
    assert first["follow_up"]["double_act_part"] == 2
    assert first["follow_up"]["trigger_id"] == first["trigger_id"] == 23
    assert first["follow_up"]["message"]
    assert runtime["proactive_counts"]["3"] == 2
    assert choose_proactive(runtime, [55], mission_num=3) is None
    assert runtime["messages"] == [first, first["follow_up"]]


def test_cinematic_queue_is_durable_until_drained():
    runtime = new_runtime()
    assert choose_proactive(runtime, [40], mission_num=1, queue=True) is None
    assert len(runtime["pending"]) == 1
    assert drain_pending(runtime)[0]["trigger_id"] == 40
    assert drain_pending(runtime) == []


def test_natural_density_is_probabilistic_and_recent_speech_reduces_it():
    baseline = sum(
        should_speak(
            new_runtime(), mission_num=2, base_probability=0.5,
            rng=random.Random(seed),
        )
        for seed in range(500)
    )
    recently_spoke = 0
    for seed in range(500):
        runtime = new_runtime()
        runtime["proactive_counts"]["1"] = 1
        recently_spoke += should_speak(
            runtime, mission_num=2, base_probability=0.5,
            rng=random.Random(seed),
        )

    assert 190 < baseline < 310
    assert recently_spoke < baseline * 0.7


def test_room_scheduler_never_emits_at_phase_start(monkeypatch):
    game = GameState("TIME")
    for index in range(6):
        add_player(game, f"Player {index}", f"player-{index}")
    game.phase = GamePhase.DISCUSSION
    game.narrator_runtime = new_runtime()
    message = choose_proactive(
        game.narrator_runtime, [40], mission_num=2, rng=random.Random(4)
    )
    monkeypatch.setattr(server.time, "time", lambda: 100.0)
    monkeypatch.setattr(server, "secure_random", MidpointRandom())

    server.schedule_narrator(
        game,
        message,
        delay_range=(7.0, 35.0),
        expires_in=60.0,
        allowed_phases={GamePhase.DISCUSSION},
    )

    scheduled = game.narrator_runtime["scheduled"]
    assert len(scheduled) == 1
    assert scheduled[0]["due_at"] == 121.0
    assert scheduled[0]["expires_at"] == 160.0
    assert game.narrator_runtime["last_narrator_at"] == 0.0


def test_direct_replies_have_room_cooldown_and_per_mission_limit():
    runtime = new_runtime()
    assert direct_reply(runtime, "@Narrator who is evil?", mission_num=1, now=100)
    assert direct_reply(runtime, "@Narrator who should I trust?", mission_num=1, now=129) is None
    assert direct_reply(runtime, "@Narrator who should I trust?", mission_num=1, now=130)
    assert direct_reply(runtime, "@Narrator how should I vote?", mission_num=1, now=160)
    assert runtime["direct_counts"]["1"] == DIRECT_LIMIT_PER_MISSION
    assert direct_reply(runtime, "@Narrator am I suspicious?", mission_num=1, now=190) is None
    # Direct replies do not consume proactive allowance.
    assert runtime["proactive_counts"] == {}


def test_tie_is_described_as_rejection_candidate():
    result = {
        "approve_count": 3,
        "reject_count": 3,
        "approved": False,
        "votes": {},
    }
    assert 23 in vote_candidates(public_state(), result)


@pytest.mark.parametrize(
    ("player_count", "mission_num", "passed", "fails", "eligible"),
    [
        (7, 4, True, 1, True),
        (10, 4, True, 1, True),
        (6, 4, False, 1, False),
        (7, 3, False, 1, False),
        (7, 4, False, 1, False),
        (7, 4, True, 0, False),
    ],
)
def test_quest_four_double_fail_bank_is_precise(
    player_count, mission_num, passed, fails, eligible
):
    state = public_state(player_count=player_count, mission_num=mission_num)
    candidates = mission_candidates(
        state,
        {"passed": passed, "fail_count": fails},
        None,
    )
    assert (43 in candidates) is eligible


@pytest.mark.parametrize(
    "secret",
    [
        {"roles": {"Arthur": "Merlin"}},
        {"team": "evil"},
        {"night_info": ["Morgana"]},
        {"mission_cards": {"Arthur": "fail"}},
        {"nested": [{"cards_shuffled": ["fail"]}]},
    ],
)
def test_pre_finale_boundary_rejects_secret_data(secret):
    with pytest.raises(ValueError):
        validate_public_payload(secret)


def test_lines_do_not_repeat_within_game_and_recent_lines_are_deprioritized():
    runtime = new_runtime()
    ids = []
    for mission in range(1, 11):
        message = choose_proactive(runtime, [40], mission_num=mission, rng=random.Random(mission))
        ids.append(message["template_id"])
    assert len(set(ids)) == len(ids)

    rematch = new_runtime()
    rematch["recent_line_ids"] = ids
    message = choose_proactive(rematch, [40], mission_num=1, rng=random.Random(1))
    assert message["template_id"] not in ids


@pytest.mark.parametrize(
    ("winner", "reason", "trigger_ids"),
    [
        ("evil", "missions", {81}),
        ("evil", "assassination", {79, 82}),
        ("good", "assassination_failed", {80, 83}),
    ],
)
def test_final_word_uses_outcome_specific_banks(winner, reason, trigger_ids):
    message = final_word(
        new_runtime(),
        {"winner": winner, "win_reason": reason, "mission_results": []},
        random.Random(1),
    )
    assert message["trigger_id"] in trigger_ids
    assert message["final_word"] is True
