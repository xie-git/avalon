"""State-aware, public-information-only narrator for Avalon.

The live engine deliberately accepts plain public snapshots rather than a
``GameState``.  Keeping that boundary here prevents a joke from accidentally
consulting roles, night knowledge, or individual mission cards.
"""

from __future__ import annotations

import random
import re
import time
from collections import Counter
from dataclasses import dataclass, field
from typing import Any


NARRATOR_NAME = "Court Narrator"
DIRECT_COOLDOWN_SECONDS = 30
DIRECT_LIMIT_PER_MISSION = 3
PROACTIVE_SOFT_LIMIT = 1
PROACTIVE_HARD_LIMIT = 2
DOUBLE_ACT_CHANCE = 0.07
SHORT_DELIVERY_CHANCE = 0.52


TRIGGERS: dict[int, str] = {
    1: "fresh_opening", 2: "rematch_opening", 3: "new_leader",
    4: "quiet_discussion", 5: "active_discussion", 6: "discussion_final_15",
    7: "unlimited_discussion_long", 8: "narrator_mention",
    9: "slow_proposal", 10: "last_second_proposal", 11: "leader_included",
    12: "leader_excluded", 13: "same_party_again", 14: "rejected_party_again",
    15: "failed_party_reused", 16: "successful_party_reunited",
    17: "three_quest_selection_streak", 18: "unselected_by_mission_three",
    19: "one_member_swap", 20: "returning_rejected_leader",
    21: "unanimous_approval", 22: "unanimous_rejection", 23: "tied_rejection",
    24: "approval_by_one", 25: "rejection_by_one", 26: "lone_reject",
    27: "lone_approve", 28: "member_rejects_self", 29: "all_members_approve",
    30: "multiple_members_reject", 31: "vote_flip_same_party",
    32: "approve_streak", 33: "reject_streak", 34: "second_rejection",
    35: "third_rejection", 36: "fourth_rejection", 37: "binding_fifth",
    38: "quest_after_first_proposal", 39: "quest_after_rejections",
    40: "zero_fail_success", 41: "one_fail_failure", 42: "multi_fail_failure",
    43: "double_fail_quest_four_success", 44: "success_after_narrow_approval",
    45: "failure_after_unanimous_approval", 46: "success_after_divisive_vote",
    47: "player_on_consecutive_failures", 48: "core_consecutive_successes",
    49: "good_leads_two_zero", 50: "evil_leads_two_zero", 51: "good_ties_two_two",
    52: "evil_ties_two_two", 53: "decisive_fifth", 54: "assassin_phase",
    55: "disconnect", 56: "reconnect", 57: "repeat_reconnect",
    58: "multiple_connection_trouble", 59: "spectator_dramatic_arrival",
    60: "chat_silent_minutes", 61: "chat_suddenly_active",
    62: "repeated_player_mentions", 63: "repeated_accusation",
    64: "repeated_certainty_words", 65: "direct_generic", 66: "direct_who_evil",
    67: "direct_trust", 68: "direct_vote", 69: "direct_am_i_suspicious",
    70: "direct_insult", 71: "direct_compliment", 72: "direct_spoilers",
    73: "direct_dating", 74: "direct_roast", 75: "direct_blame",
    76: "direct_unknown", 77: "assassin_begins", 78: "assassin_slow",
    79: "assassin_correct", 80: "assassin_misses", 81: "evil_three_failures",
    82: "evil_assassin_win", 83: "good_assassin_miss", 84: "winner_comeback",
    85: "winner_sweep", 86: "final_quest_decider", 87: "accused_good",
    88: "defended_evil", 89: "votes_supported_evil", 90: "votes_opposed_evil",
    91: "many_failed_quests", 92: "many_successful_quests",
    93: "rematch_requests", 94: "instant_unanimous_rematch",
}

# One authored premise per situation, expanded through twenty authored delivery
# tags.  The result is 1,880 stable, individually identified lines while keeping
# the source reviewable by humans.
_PREMISES = [
    "Fresh game, fresh loyalties, same suspicious eye contact.",
    "A rematch: because apparently the previous betrayal lacked closure.",
    "{leader} has the crown. Try not to make it look like evidence.",
    "This discussion is so quiet I can hear the alibis fermenting.",
    "Everyone is talking; truth has wisely left the building.",
    "Fifteen seconds. Time to promote a hunch into a legal argument.",
    "Unlimited discussion has become a hostage situation with snacks.",
    "I heard my name. I assume standards have collapsed.",
    "{leader} is marinating that proposal past the use-by date.",
    "Submitted at the bell: confidence with the paperwork of panic.",
    "{leader} selected themselves. A touching vote of self-interest.",
    "{leader} stayed home. Either humility or an alibi with excellent tailoring.",
    "The identical party returns, now with absolutely no new information.",
    "You rejected this party before; nostalgia truly is incurable.",
    "That failed fellowship has been reheated and plated as strategy.",
    "The successful band is back together. Ego tour begins now.",
    "{player} has a third consecutive quest. Frequent-flyer treason points unlocked.",
    "Mission three and {player} still has cleaner boots than everyone else.",
    "One member changed. Behold: radical reform.",
    "{leader} returns after a rejected proposal, carrying no resentment whatsoever.",
    "Unanimous approval: the rare sound of everyone being wrong together.",
    "Unanimous rejection. The table has discovered teamwork through spite.",
    "A tie rejects the party. Even arithmetic has trust issues here.",
    "Approved by one vote: a mandate written in disappearing ink.",
    "Rejected by one vote. Someone just became tonight's group-chat topic.",
    "One lone reject, bravely ruining the family photo.",
    "One lone approve. Hope is adorable when isolated.",
    "{player} rejected a party containing themselves. Self-awareness or insurance fraud?",
    "Every proposed member approved. The product endorsed itself.",
    "Several party members rejected their own trip. Read the reviews.",
    "Same party, different vote from {player}. Character development or weather vane?",
    "{player} keeps approving. A golden retriever has entered parliament.",
    "{player} keeps rejecting. The drawbridge has a drawbridge.",
    "Two rejected parties. Mild dysfunction has become a theme.",
    "Three rejections. The round table is now mostly sharp corners.",
    "Four rejections. The next leader gets consent removed from the menu.",
    "Fifth proposal: binding, vote-free, and sponsored by consequences.",
    "First proposal approved. Suspiciously efficient; check everyone for wires.",
    "After all those rejections, a quest finally escaped committee.",
    "Zero Fails. Either heroes, cowards, or excellent accountants.",
    "Exactly one Fail. A solo artist has entered the charts.",
    "Multiple Fails. Treason has formed a project team.",
    "Quest Four survived one Fail because the large-table rules enjoy chaos.",
    "Narrowly approved, successfully completed. Democracy accidentally shipped a feature.",
    "Unanimously approved, then failed. Put that confidence in a museum.",
    "A divisive vote produced success. Consensus remains overrated.",
    "{player} appears on consecutive failures. An unfortunate loyalty programme.",
    "The same core keeps succeeding. Competence is becoming deeply suspicious.",
    "Good leads two–nil. Evil may now begin pretending this was the plan.",
    "Evil leads two–nil. The optimism budget has been cut.",
    "Good ties it two–two. The finale has acquired expensive lighting.",
    "Evil ties it two–two. Nobody's pulse needed that.",
    "Mission Five decides everything. Please place all terrible instincts on the table.",
    "Three successes summon the Assassin. Victory comes with an invoice.",
    "{player} disconnected. Even their internet rejected the proposal.",
    "{player} returns from the void, allegedly with the same opinions.",
    "{player} reconnects again. Their Wi-Fi is playing an independent social-deduction game.",
    "Connection trouble is spreading. Mordred has apparently hired the router.",
    "A spectator arrives at the dramatic bit. Impeccable rubbernecking.",
    "Chat has been silent for minutes. The screenshots must be thriving.",
    "Chat just caught fire. Facts are not expected to survive.",
    "{player} keeps entering the conversation like an unpaid subscription.",
    "The table keeps accusing {player}. Repetition: evidence's cheaper cousin.",
    "Trust, sus, obvious, definitely: four horsemen of the bad argument.",
    "You rang? I was busy documenting the confidence-to-evidence ratio.",
    "Who is Evil? Statistically, someone currently acting extremely helpful.",
    "Trust the person whose certainty has the shortest warranty.",
    "Vote with your conscience, then blame the seating chart.",
    "Are you suspicious? Asking has moved the needle in an unhelpful direction.",
    "Insulting the narrator is legal, but your voting record remains discoverable.",
    "Flattery accepted. It will purchase exactly zero secret information.",
    "Spoilers cost one soul and I still refuse to provide them.",
    "I am single by court order and emotionally committed to bad decisions.",
    "I'll roast {player}: their alibi has the structural integrity of wet pastry.",
    "Blame me if you like; I have minutes and you have a voting record.",
    "I cannot classify that question, which may be its strongest quality.",
    "The Assassin steps forward. Good's celebration has entered a probationary period.",
    "The Assassin is taking their time, aging every Good player visibly.",
    "Merlin identified. Evil read the room and then set fire to the library.",
    "The Assassin missed. All that menace, straight into the scenery.",
    "Three failed quests: Evil wins by making disaster look procedural.",
    "Merlin falls. Evil steals the ending after Good wrote three acts.",
    "The Assassin missed, and Good survives the world's least relaxing victory lap.",
    "The winners came from behind. Never underestimate spite with momentum.",
    "A clean sweep. The losing side was present in a largely decorative capacity.",
    "A two–two final quest decided it. Subtlety died several minutes ago.",
    "{player} was Good after all. Please recycle your accusations responsibly.",
    "{player} was Evil. Those passionate defenders may collect their receipts.",
    "{player}'s votes gave Evil a remarkably comfortable chair.",
    "{player}'s votes kept opposing Evil. Annoying, but in retrospect heroic.",
    "{player} attended an impressive number of failed quests. Terrible tourism.",
    "{player} attended an impressive number of successes. LinkedIn post incoming.",
    "The rematch requests begin before the emotional paperwork is complete.",
    "Everyone wants the rematch immediately. Healing has been unanimously rejected.",
]

_DELIVERIES = (
    "The court records this without judgment. Mostly.", "Do sit with that.",
    "No refunds on certainty.", "The minutes will be unkind.",
    "A perfectly normal kingdom.", "Proceed with undeserved confidence.",
    "I have sharpened the footnote.", "History is already smirking.",
    "Nothing ominous there.", "The tavern odds just moved.",
    "Your dignity remains optional.", "Please continue incriminating yourselves.",
    "Camelot deserves better gossip.", "An adult has not been located.",
    "This will age beautifully.", "The crown accepts no liability.",
    "Someone pour the evidence another drink.", "I adore a preventable crisis.",
    "The confidence is exquisite.", "And scene.",
)

assert len(_PREMISES) == 94
COPY_BANKS: dict[int, tuple[str, ...]] = {
    trigger_id: tuple(f"{premise} {delivery}" for delivery in _DELIVERIES)
    for trigger_id, premise in enumerate(_PREMISES, 1)
}

PRIORITY = {
    **{key: 70 for key in range(1, 95)},
    1: 82, 2: 84, 6: 82, 7: 84, 62: 80, 63: 84, 64: 80,
    **{key: 78 for key in range(13, 21)},
    21: 82, 22: 84,
    **{key: 86 for key in range(40, 55)},
    23: 98, 36: 96, 37: 100, 43: 96, 54: 100, 55: 94, 56: 92, 57: 95,
    58: 96, 77: 100, 78: 94,
    **{key: 88 for key in range(87, 93)},
}
FINAL_TRIGGER_IDS = frozenset(range(79, 95))
DIRECT_TRIGGER_IDS = frozenset(range(65, 77))
EXCEPTIONAL_TRIGGER_IDS = frozenset({23, 36, 37, 43, 55, 57, 58, 78})

# Rare second beats are written as continuations, not interchangeable one-liners.
# A double-act consumes both proactive slots for the mission at once.
DOUBLE_ACT_FOLLOWUPS: dict[int, tuple[str, ...]] = {
    23: (
        "No, staring at the three dissenters will not make it four–two.",
        "The motion fails; the grudges, however, pass unanimously.",
        "Please direct complaints to mathematics, who will ignore them.",
        "A dead heat is still dead. Lovely symmetry, though.",
    ),
    36: (
        "One more rejection and democracy is taken behind the castle.",
        "The fifth leader is warming up their benevolent dictatorship.",
        "Do reject again. I enjoy watching consequences put on boots.",
        "Next proposal comes with no ballot and several raised eyebrows.",
    ),
    37: (
        "You had four chances to cooperate. The rulebook has stopped asking.",
        "The table wanted certainty; it has received compulsory tourism.",
        "No vote this time. Your previous votes were quite sufficient.",
        "Consent has left a note and gone to the tavern.",
    ),
    42: (
        "At least the traitors found colleagues in this economy.",
        "That was less sabotage than a departmental initiative.",
        "One Fail whispers. Several Fails submit a quarterly report.",
        "The conspiracy has apparently secured group health insurance.",
    ),
    43: (
        "One saboteur did the work and still failed the assignment.",
        "Somewhere, Evil is rereading the two-Fail footnote very slowly.",
        "A technical success: the most irritating species of success.",
        "The second Fail was invited. It declined to attend.",
    ),
    45: (
        "Everyone trusted the party. The party treasured that mistake.",
        "A perfect mandate followed by an imperfect little catastrophe.",
        "Please keep your unanimous confidence away from heavy machinery.",
        "Consensus has requested that this result be sealed.",
    ),
    55: (
        "We shall preserve their seat and misremember their arguments.",
        "Until they return, their silence is their strongest defence.",
        "The empty chair has already improved its voting record.",
        "Someone tell the router that desertion is not a legal vote.",
    ),
    57: (
        "At this point the router deserves its own loyalty card.",
        "Welcome back. Again. The void says hello.",
        "Their connection has now had more reversals than the table.",
        "The Wi-Fi remains the evening's most convincing traitor.",
    ),
    58: (
        "If the candles start buffering, abandon the castle.",
        "The network has rejected the entire fellowship.",
        "Mordred denies responsibility, which is honestly suspicious.",
        "Please accuse one another locally while service is restored.",
    ),
}


@dataclass(frozen=True)
class PublicNarratorState:
    mission_num: int
    player_count: int
    player_names: tuple[str, ...]
    leader_name: str | None
    mission_results: tuple[str, ...]
    mission_history: tuple[dict[str, Any], ...]
    proposal_history: tuple[dict[str, Any], ...]
    proposed_team: tuple[str, ...]
    consecutive_rejections: int
    discussion_seconds: int
    phase_elapsed_seconds: int
    reconnect_counts: dict[str, int] = field(default_factory=dict)
    chat_counts: dict[str, int] = field(default_factory=dict)
    mention_counts: dict[str, int] = field(default_factory=dict)
    accusation_counts: dict[str, int] = field(default_factory=dict)
    vote_history: tuple[dict[str, Any], ...] = ()
    previous_game: dict[str, Any] | None = None


FORBIDDEN_PUBLIC_KEYS = frozenset({
    "role", "roles", "team", "teams", "allegiance", "night_info",
    "mission_cards", "cards_shuffled", "assassin_target",
})


def validate_public_payload(value: Any, path: str = "state") -> None:
    """Reject secret-bearing keys recursively before pre-finale evaluation."""
    if isinstance(value, dict):
        forbidden = FORBIDDEN_PUBLIC_KEYS.intersection(value)
        if forbidden:
            raise ValueError(f"Private narrator data at {path}: {sorted(forbidden)}")
        for key, child in value.items():
            validate_public_payload(child, f"{path}.{key}")
    elif isinstance(value, (list, tuple)):
        for index, child in enumerate(value):
            validate_public_payload(child, f"{path}[{index}]")


def new_runtime(previous_game: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "mission_num": 1, "proactive_counts": {}, "direct_counts": {},
        "last_direct_at": 0.0, "used_line_ids": [],
        "recent_line_ids": list((previous_game or {}).get("narrator_line_ids", ())),
        "pending": [], "messages": [], "reconnect_counts": {},
        "scheduled": [], "last_public_chat_at": 0.0, "last_narrator_at": 0.0,
        "chat_counts": {}, "mention_counts": {}, "accusation_counts": {},
        "certainty_count": 0, "previous_game": previous_game,
    }


def _line(trigger_id: int, runtime: dict[str, Any], rng: random.Random) -> dict[str, Any]:
    used = set(runtime.get("used_line_ids", ()))
    recent = set(runtime.get("recent_line_ids", ()))
    candidates = []
    for index, text in enumerate(COPY_BANKS[trigger_id], 1):
        line_id = f"{trigger_id}.{index}"
        if line_id not in used and line_id not in recent:
            candidates.append((line_id, text))
    if not candidates:
        candidates = [
            (f"{trigger_id}.{index}", text)
            for index, text in enumerate(COPY_BANKS[trigger_id], 1)
            if f"{trigger_id}.{index}" not in used
        ] or list((f"{trigger_id}.{index}", text) for index, text in enumerate(COPY_BANKS[trigger_id], 1))
    line_id, copy = rng.choice(candidates)
    # Sometimes stop after the authored premise.  Varying sentence length is
    # less mechanical than attaching a courtly button to every observation.
    if rng.random() < SHORT_DELIVERY_CHANCE:
        copy = _PREMISES[trigger_id - 1]
    runtime.setdefault("used_line_ids", []).append(line_id)
    return {
        "actor_type": "narrator", "name": NARRATOR_NAME, "message": copy,
        "trigger_id": trigger_id, "template_id": line_id,
    }


def choose_proactive(
    runtime: dict[str, Any], candidates: list[int], *, mission_num: int,
    threshold: int = 72, queue: bool = False, rng: random.Random | None = None,
) -> dict[str, Any] | None:
    """Choose at most one candidate and enforce the one/two-per-mission policy."""
    if not candidates:
        return None
    counts = runtime.setdefault("proactive_counts", {})
    key = str(mission_num)
    count = int(counts.get(key, 0))
    selector = rng or random.SystemRandom()
    ranked = sorted(
        set(candidates),
        key=lambda item: (PRIORITY.get(item, 0), selector.random()),
        reverse=True,
    )
    trigger_id = ranked[0]
    if PRIORITY.get(trigger_id, 0) < threshold or count >= PROACTIVE_HARD_LIMIT:
        return None
    if count >= PROACTIVE_SOFT_LIMIT and trigger_id not in EXCEPTIONAL_TRIGGER_IDS:
        return None
    message = _line(trigger_id, runtime, selector)
    message["mission_num"] = mission_num
    message_count = 1
    if (
        count == 0
        and trigger_id in DOUBLE_ACT_FOLLOWUPS
        and selector.random() < DOUBLE_ACT_CHANCE
    ):
        followups = DOUBLE_ACT_FOLLOWUPS[trigger_id]
        followup_index = selector.randrange(len(followups))
        followup = {
            "actor_type": "narrator",
            "name": NARRATOR_NAME,
            "message": followups[followup_index],
            "trigger_id": trigger_id,
            "template_id": f"{trigger_id}.double.{followup_index + 1}",
            "mission_num": mission_num,
            "double_act_part": 2,
        }
        message["double_act_part"] = 1
        message["follow_up"] = followup
        runtime.setdefault("used_line_ids", []).append(followup["template_id"])
        message_count = 2
    counts[key] = count + message_count
    runtime.setdefault("messages", []).append(message)
    if message.get("follow_up"):
        runtime["messages"].append(message["follow_up"])
    if queue:
        runtime.setdefault("pending", []).append(message)
        return None
    return message


def should_speak(
    runtime: dict[str, Any], *, mission_num: int, base_probability: float,
    rng: random.Random | None = None,
) -> bool:
    """Probabilistic density control; silence is the most common alternative."""
    selector = rng or random.SystemRandom()
    probability = max(0.0, min(1.0, float(base_probability)))
    counts = runtime.get("proactive_counts", {})
    if int(counts.get(str(mission_num - 1), 0)):
        probability *= 0.58
    elif mission_num >= 3 and not any(
        int(counts.get(str(previous), 0))
        for previous in (mission_num - 1, mission_num - 2)
    ):
        probability = min(0.82, probability + 0.10)
    return selector.random() < probability


def drain_pending(runtime: dict[str, Any]) -> list[dict[str, Any]]:
    pending = list(runtime.get("pending", ()))
    runtime["pending"] = []
    return pending


def classify_direct(message: str) -> int | None:
    text = message.lower()
    if not re.search(r"(?:@\s*)?narrator\b|court narrator", text):
        return None
    if re.search(r"who(?:'s| is) evil|which .*evil", text): return 66
    if re.search(r"who .*trust|trust whom|can i trust", text): return 67
    if re.search(r"how .*vote|what .*vote|approve or reject", text): return 68
    if re.search(r"am i .*sus|i suspicious|do i look sus", text): return 69
    if re.search(r"shut up|idiot|stupid|useless|hate you|fuck you", text): return 70
    if re.search(r"love you|good narrator|great narrator|clever|funny", text): return 71
    if re.search(r"spoiler|tell .*role|reveal .*role|who is merlin", text): return 72
    if re.search(r"single|date|dating|marry|relationship", text): return 73
    if re.search(r"roast|insult .* for me", text): return 74
    if re.search(r"your fault|blame you|you did this", text): return 75
    if "?" not in text and len(text.split()) <= 4: return 65
    return 76


def direct_reply(
    runtime: dict[str, Any], message: str, *, mission_num: int,
    now: float | None = None, player: str | None = None,
    rng: random.Random | None = None,
) -> dict[str, Any] | None:
    trigger_id = classify_direct(message)
    if trigger_id is None:
        return None
    now = time.time() if now is None else now
    key = str(mission_num)
    count = int(runtime.setdefault("direct_counts", {}).get(key, 0))
    if count >= DIRECT_LIMIT_PER_MISSION or now - float(runtime.get("last_direct_at", 0)) < DIRECT_COOLDOWN_SECONDS:
        return None
    reply = _line(trigger_id, runtime, rng or random.SystemRandom())
    if player:
        reply["message"] = reply["message"].replace("{player}", player)
    runtime["direct_counts"][key] = count + 1
    runtime["last_direct_at"] = now
    runtime.setdefault("messages", []).append(reply)
    return reply


def vote_candidates(state: PublicNarratorState, result: dict[str, Any]) -> list[int]:
    approvals, rejections = result["approve_count"], result["reject_count"]
    votes, party = result.get("votes", {}), set(state.proposed_team)
    out: list[int] = []
    if rejections == 0: out.append(21)
    if approvals == 0: out.append(22)
    if approvals == rejections: out.append(23)
    if approvals == rejections + 1: out.append(24)
    if rejections == approvals + 1: out.append(25)
    if rejections == 1: out.append(26)
    if approvals == 1: out.append(27)
    if any(name in party and vote == "reject" for name, vote in votes.items()): out.append(28)
    if party and all(votes.get(name) == "approve" for name in party): out.append(29)
    if sum(votes.get(name) == "reject" for name in party) >= 2: out.append(30)
    prior_same = next(
        (
            item for item in reversed(state.vote_history)
            if set(item.get("party", ())) == party
        ),
        None,
    )
    if prior_same and any(
        prior_same.get("votes", {}).get(name) != choice
        for name, choice in votes.items()
        if name in prior_same.get("votes", {})
    ):
        out.append(31)
    for name, choice in votes.items():
        recent = [item.get("votes", {}).get(name) for item in state.vote_history[-2:]] + [choice]
        if len(recent) == 3 and all(item == "approve" for item in recent): out.append(32)
        if len(recent) == 3 and all(item == "reject" for item in recent): out.append(33)
    streak = state.consecutive_rejections + (0 if result.get("approved") else 1)
    if streak in (2, 3, 4): out.append({2: 34, 3: 35, 4: 36}[streak])
    return out


def mission_candidates(state: PublicNarratorState, result: dict[str, Any], proposal: dict[str, Any] | None) -> list[int]:
    passed, fails = bool(result["passed"]), int(result["fail_count"])
    out: list[int] = []
    if passed and fails == 0: out.append(40)
    if not passed and fails == 1: out.append(41)
    if not passed and fails > 1: out.append(42)
    if state.mission_num == 4 and 7 <= state.player_count <= 10 and passed and fails == 1: out.append(43)
    if proposal:
        margin = abs(int(proposal.get("approve_count", 0)) - int(proposal.get("reject_count", 0)))
        if passed and margin == 1: out.append(44)
        if not passed and int(proposal.get("reject_count", 0)) == 0: out.append(45)
        if passed and int(proposal.get("reject_count", 0)) >= 2: out.append(46)
    projected = list(state.mission_results) + ["pass" if passed else "fail"]
    if projected == ["pass", "pass"]: out.append(49)
    if projected == ["fail", "fail"]: out.append(50)
    if len(projected) == 4 and projected.count("pass") == 2:
        out.append(51 if passed else 52)
        out.append(53)
    if projected.count("pass") == 3: out.append(54)
    current_party = set(state.proposed_team)
    if state.mission_history:
        previous = state.mission_history[-1]
        previous_party = set(previous.get("party", ()))
        if not passed and not previous.get("passed") and current_party & previous_party:
            out.append(47)
        if passed and previous.get("passed") and len(current_party & previous_party) >= max(2, len(current_party) - 1):
            out.append(48)
    return out


def final_word(runtime: dict[str, Any], summary: dict[str, Any], rng: random.Random | None = None) -> dict[str, Any]:
    """Select finale copy; this is the only role-aware narrator entry point."""
    candidates: list[int] = []
    reason, winner = summary.get("win_reason"), summary.get("winner")
    if reason == "assassination": candidates += [79, 82]
    elif reason == "assassination_failed": candidates += [80, 83]
    elif winner == "evil" and reason == "missions": candidates.append(81)
    results = summary.get("mission_results", [])
    if len(results) >= 4 and results[-1] == winner.replace("good", "pass").replace("evil", "fail"):
        if results[:2].count("pass" if winner == "evil" else "fail") == 2: candidates.append(84)
    if results and all(item == ("pass" if winner == "good" else "fail") for item in results): candidates.append(85)
    if len(results) == 5: candidates.append(86)
    roles = summary.get("roles", {})
    subject: str | None = None
    accusations = runtime.get("accusation_counts", {})
    if accusations:
        accused = max(accusations, key=accusations.get)
        team = roles.get(accused, {}).get("team")
        team = getattr(team, "value", team)
        if accusations[accused] >= 3 and team == "good":
            candidates.append(87)
            subject = accused
    mentions = runtime.get("mention_counts", {})
    defended = [name for name, count in mentions.items() if count >= 4 and accusations.get(name, 0) == 0]
    for name in defended:
        team = roles.get(name, {}).get("team")
        if getattr(team, "value", team) == "evil":
            candidates.append(88)
            subject = name
            break
    successful: Counter[str] = Counter()
    failed: Counter[str] = Counter()
    for mission in summary.get("mission_history", ()):
        bucket = successful if mission.get("passed") else failed
        for name in mission.get("team", ()):
            bucket[name] += 1
    evil_names = {
        name for name, info in roles.items()
        if getattr(info.get("team"), "value", info.get("team")) == "evil"
    }
    vote_support: Counter[str] = Counter()
    vote_opposition: Counter[str] = Counter()
    for vote in runtime.get("vote_history", ()):
        evil_on_party = bool(set(vote.get("party", ())) & evil_names)
        for name, choice in vote.get("votes", {}).items():
            if not evil_on_party:
                continue
            if choice == "approve": vote_support[name] += 1
            elif choice == "reject": vote_opposition[name] += 1
    if vote_support and max(vote_support.values()) >= 3:
        subject = max(vote_support, key=vote_support.get)
        candidates.append(89)
    if vote_opposition and max(vote_opposition.values()) >= 3:
        subject = max(vote_opposition, key=vote_opposition.get)
        candidates.append(90)
    if failed and max(failed.values()) >= 3:
        name = max(failed, key=failed.get)
        candidates.append(91)
        subject = name
    if successful and max(successful.values()) >= 3:
        name = max(successful, key=successful.get)
        candidates.append(92)
        subject = name
    trigger_id = max(candidates or [83 if winner == "good" else 81], key=lambda item: PRIORITY.get(item, 70))
    message = _line(trigger_id, runtime, rng or random.SystemRandom())
    message["message"] = message["message"].replace("{player}", subject or "someone")
    message["final_word"] = True
    return message
