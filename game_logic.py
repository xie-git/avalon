import secrets
import threading
import time
from enum import Enum


class GamePhase(str, Enum):
    LOBBY = "LOBBY"
    ROLE_ASSIGNMENT = "ROLE_ASSIGNMENT"
    NIGHT_PHASE = "NIGHT_PHASE"
    ROUND_START = "ROUND_START"
    DISCUSSION = "DISCUSSION"
    TEAM_PROPOSAL = "TEAM_PROPOSAL"
    TEAM_VOTE = "TEAM_VOTE"
    VOTE_REVEAL = "VOTE_REVEAL"
    MISSION = "MISSION"
    MISSION_REVEAL = "MISSION_REVEAL"
    ASSASSIN_PHASE = "ASSASSIN_PHASE"
    GAME_OVER = "GAME_OVER"


class Role(str, Enum):
    MERLIN = "Merlin"
    PERCIVAL = "Percival"
    LOYAL_SERVANT = "Loyal Servant"
    ASSASSIN = "Assassin"
    MORGANA = "Morgana"
    MORDRED = "Mordred"
    OBERON = "Oberon"
    MINION_OF_MORDRED = "Minion of Mordred"


class Team(str, Enum):
    GOOD = "good"
    EVIL = "evil"


ROLE_TO_TEAM = {
    Role.MERLIN: Team.GOOD,
    Role.PERCIVAL: Team.GOOD,
    Role.LOYAL_SERVANT: Team.GOOD,
    Role.ASSASSIN: Team.EVIL,
    Role.MORGANA: Team.EVIL,
    Role.MORDRED: Team.EVIL,
    Role.OBERON: Team.EVIL,
    Role.MINION_OF_MORDRED: Team.EVIL,
}

# (good_count, evil_count, [good_roles], [evil_roles])
PLAYER_COUNT_ROLES = {
    6: (
        [Role.MERLIN, Role.PERCIVAL, Role.LOYAL_SERVANT, Role.LOYAL_SERVANT],
        [Role.ASSASSIN, Role.MORGANA],
    ),
    7: (
        [Role.MERLIN, Role.PERCIVAL, Role.LOYAL_SERVANT, Role.LOYAL_SERVANT],
        [Role.ASSASSIN, Role.MORGANA, Role.MINION_OF_MORDRED],
    ),
    8: (
        [
            Role.MERLIN,
            Role.PERCIVAL,
            Role.LOYAL_SERVANT,
            Role.LOYAL_SERVANT,
            Role.LOYAL_SERVANT,
        ],
        [Role.ASSASSIN, Role.MORGANA, Role.MINION_OF_MORDRED],
    ),
    9: (
        [
            Role.MERLIN,
            Role.PERCIVAL,
            Role.LOYAL_SERVANT,
            Role.LOYAL_SERVANT,
            Role.LOYAL_SERVANT,
            Role.LOYAL_SERVANT,
        ],
        [Role.ASSASSIN, Role.MORGANA, Role.MINION_OF_MORDRED],
    ),
    10: (
        [
            Role.MERLIN,
            Role.PERCIVAL,
            Role.LOYAL_SERVANT,
            Role.LOYAL_SERVANT,
            Role.LOYAL_SERVANT,
            Role.LOYAL_SERVANT,
        ],
        [Role.ASSASSIN, Role.MORGANA, Role.MORDRED, Role.OBERON],
    ),
}

# Mission sizes per player count: [M1, M2, M3, M4, M5]
MISSION_SIZES = {
    6: [2, 3, 4, 3, 4],
    7: [2, 3, 3, 4, 4],
    8: [3, 4, 4, 5, 5],
    9: [3, 4, 4, 5, 5],
    10: [3, 4, 4, 5, 5],
}

# Mission 4 (index 3) requires 2 fails for 7+ players
DOUBLE_FAIL_THRESHOLD = 7


# Safe character set for room codes (no O, I, L, 0, 1)
ROOM_CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ"
secure_random = secrets.SystemRandom()


class PlayerInfo:
    def __init__(
        self,
        player_id: str,
        name: str,
        *,
        is_bot: bool = False,
        color_index: int = 0,
        avatar_index: int = 0,
    ):
        self.player_id = player_id
        self.name = name
        self.sid = None
        self.role: Role | None = None
        self.team: Team | None = None
        self.connected = True
        self.session_token = None
        self.is_bot = is_bot
        self.color_index = color_index
        self.avatar_index = avatar_index
        self.ready = is_bot

    def to_dict(self, include_role=False):
        d = {
            "player_id": self.player_id,
            "name": self.name,
            "connected": self.connected,
            "is_bot": self.is_bot,
            "color_index": self.color_index,
            "avatar_index": self.avatar_index,
            "ready": self.ready,
        }
        if include_role:
            d["role"] = self.role
            d["team"] = self.team
        return d


class GameState:
    def __init__(self, game_code: str):
        self.code = game_code
        self.phase = GamePhase.LOBBY
        self.players: dict[str, PlayerInfo] = {}  # player_id -> PlayerInfo
        self.player_order: list[str] = []  # ordered list of player_ids
        self.host_sid: str | None = None  # host display screen sid
        self.host_token: str | None = None  # unguessable host-screen capability
        self.lock = threading.RLock()  # serialize events for this game only

        # Settings
        self.discussion_time = 60
        self.proposal_time = 60
        self.beta_test_mode = False
        self.beta_test_player_count = 6
        self.started_at: float | None = None

        # Round state
        self.current_leader_index = 0
        self.current_mission = 0  # 0-indexed 0..4
        self.mission_results: list[str] = []  # "pass" or "fail"
        self.mission_history: list[dict] = []
        self.proposal_history: list[dict] = []
        self.consecutive_rejections = 0

        # Per-phase state
        self.proposed_team: list[str] = []  # player_ids
        self.votes: dict[str, str] = {}  # player_id -> "approve"/"reject"
        self.mission_cards: dict[str, str] = {}  # player_id -> "success"/"fail"
        self.night_acks: set[str] = set()

        # End state
        self.assassin_target: str | None = None
        self.winner: str | None = None
        self.win_reason: str | None = None

        # Pending mission advance (set after mission_reveal; cleared when host clicks Next Round)
        self.pending_mission_outcome: str | None = (
            None  # "next_mission" | "assassin_phase" | "evil_wins"
        )

        # Timer cancellation flag
        self.timer_phase_key: str | None = None
        self.timer_deadline: float | None = None
        self.timer_kind: str | None = None

        # Host-issued, short-lived recovery codes for disconnected seats.
        self.seat_recovery_codes: dict[str, tuple[str, float]] = {}

    def player_count(self) -> int:
        return len(self.players)

    def public_players(self):
        return [p.to_dict() for p in self.player_order_list()]

    def player_order_list(self) -> list[PlayerInfo]:
        return [self.players[pid] for pid in self.player_order if pid in self.players]

    def current_leader(self) -> PlayerInfo | None:
        if not self.player_order:
            return None
        idx = self.current_leader_index % len(self.player_order)
        return self.players.get(self.player_order[idx])

    def mission_size(self) -> int:
        return MISSION_SIZES[self.player_count()][self.current_mission]

    def requires_double_fail(self) -> bool:
        return (
            self.current_mission == 3 and self.player_count() >= DOUBLE_FAIL_THRESHOLD
        )

    def good_wins(self) -> int:
        return self.mission_results.count("pass")

    def evil_wins_count(self) -> int:
        return self.mission_results.count("fail")

    def reset(self) -> None:
        """Return the same connected group to the lobby for another game."""
        self.phase = GamePhase.LOBBY
        for player in self.players.values():
            player.role = None
            player.team = None
            player.ready = player.is_bot
        self.current_leader_index = 0
        self.current_mission = 0
        self.mission_results = []
        self.mission_history = []
        self.proposal_history = []
        self.consecutive_rejections = 0
        self.proposed_team = []
        self.votes = {}
        self.mission_cards = {}
        self.night_acks = set()
        self.assassin_target = None
        self.winner = None
        self.win_reason = None
        self.timer_phase_key = None
        self.timer_deadline = None
        self.timer_kind = None
        self.seat_recovery_codes = {}
        self.pending_mission_outcome = None
        self.started_at = None


# ---------------------------------------------------------------------------
# Pure functions
# ---------------------------------------------------------------------------


def generate_game_code(existing_codes: set[str]) -> str:
    for _ in range(1000):
        code = "".join(secrets.choice(ROOM_CODE_CHARS) for _ in range(4))
        if code not in existing_codes:
            return code
    raise RuntimeError("Could not generate unique game code")


def add_player(game: GameState, name: str, player_id: str) -> PlayerInfo:
    """Add a player to the lobby. Raises ValueError on validation failure."""
    if game.phase != GamePhase.LOBBY:
        raise ValueError("Game has already started")
    if len(game.players) >= 10:
        raise ValueError("Game is full (max 10 players)")
    name = name.strip()
    if not name:
        raise ValueError("Name cannot be empty")
    if len(name) > 12:
        raise ValueError("Name must be 12 characters or fewer")
    if not all(c.isalnum() or c == " " for c in name):
        raise ValueError("Name must contain only letters, numbers, and spaces")
    for p in game.players.values():
        if p.name.lower() == name.lower():
            raise ValueError(f"Name '{name}' is already taken")
    used_colors = {player.color_index for player in game.players.values()}
    color_index = next(index for index in range(10) if index not in used_colors)
    player = PlayerInfo(
        player_id=player_id,
        name=name,
        color_index=color_index,
        avatar_index=color_index % 8,
    )
    game.players[player_id] = player
    game.player_order.append(player_id)
    return player


def remove_player(game: GameState, player_id: str) -> None:
    if player_id in game.players:
        del game.players[player_id]
    if player_id in game.player_order:
        game.player_order.remove(player_id)


def reorder_players(game: GameState, ordered_names: list[str]) -> None:
    """Set player_order by name. Raises ValueError if names don't match."""
    name_to_id = {p.name: pid for pid, p in game.players.items()}
    if (
        len(ordered_names) != len(name_to_id)
        or len(set(ordered_names)) != len(ordered_names)
        or set(ordered_names) != set(name_to_id)
    ):
        raise ValueError("Player list mismatch")
    game.player_order = [name_to_id[n] for n in ordered_names]


# ---------------------------------------------------------------------------
# Role assignment
# ---------------------------------------------------------------------------


def assign_roles(game: GameState) -> None:
    n = game.player_count()
    if n not in PLAYER_COUNT_ROLES:
        raise ValueError(f"Invalid player count: {n}")
    good_roles, evil_roles = PLAYER_COUNT_ROLES[n]
    all_roles = list(good_roles) + list(evil_roles)
    secure_random.shuffle(all_roles)
    for pid, role in zip(game.player_order, all_roles):
        player = game.players[pid]
        player.role = role
        player.team = ROLE_TO_TEAM[role]
    game.current_leader_index = secure_random.randrange(n)
    game.phase = GamePhase.ROLE_ASSIGNMENT


def get_night_phase_info(game: GameState, player_id: str) -> dict:
    """Return what this player sees during the night phase."""
    player = game.players[player_id]
    role = player.role
    info = {"role": role, "team": player.team, "sees": []}

    def names_of(pids):
        return [game.players[pid].name for pid in pids if pid != player_id]

    if role == Role.MERLIN:
        # Sees all evil EXCEPT Mordred
        evil_visible = [
            pid
            for pid, p in game.players.items()
            if p.team == Team.EVIL and p.role != Role.MORDRED
        ]
        info["sees"] = names_of(evil_visible)
        info["sees_label"] = "Agents of evil"

    elif role == Role.PERCIVAL:
        # Sees Merlin and Morgana, but not which is which
        targets = [
            pid
            for pid, p in game.players.items()
            if p.role in (Role.MERLIN, Role.MORGANA)
        ]
        secure_random.shuffle(targets)
        info["sees"] = names_of(targets)
        info["sees_label"] = "One is Merlin, one is Morgana — but which?"

    elif role in (
        Role.ASSASSIN,
        Role.MORGANA,
        Role.MORDRED,
        Role.MINION_OF_MORDRED,
    ):
        # See each other, but NOT Oberon
        evil_visible = [
            pid
            for pid, p in game.players.items()
            if p.team == Team.EVIL and p.role != Role.OBERON and pid != player_id
        ]
        info["sees"] = names_of(evil_visible)
        info["sees_label"] = "Fellow agents of evil"

    elif role == Role.OBERON:
        info["sees"] = []
        info["sees_label"] = "You serve evil in solitude"

    else:  # Loyal Servant
        info["sees"] = []
        info["sees_label"] = "You have no special knowledge"

    return info


# ---------------------------------------------------------------------------
# Team proposal and voting
# ---------------------------------------------------------------------------


def validate_team_proposal(game: GameState, team_player_ids: list[str]) -> None:
    required = game.mission_size()
    if len(team_player_ids) != required:
        raise ValueError(f"Team must have exactly {required} members")
    if len(set(team_player_ids)) != len(team_player_ids):
        raise ValueError("Duplicate players in team")
    for pid in team_player_ids:
        if pid not in game.players:
            raise ValueError(f"Unknown player id: {pid}")


def record_vote(game: GameState, player_id: str, vote: str) -> dict | None:
    """Record a vote. Returns result dict when all have voted, else None."""
    if player_id in game.votes:
        raise ValueError("Already voted")
    if vote not in ("approve", "reject"):
        raise ValueError("Vote must be 'approve' or 'reject'")
    game.votes[player_id] = vote
    if len(game.votes) == len(game.players):
        approvals = sum(1 for v in game.votes.values() if v == "approve")
        rejections = len(game.votes) - approvals
        approved = approvals > rejections
        return {
            "votes": {game.players[pid].name: v for pid, v in game.votes.items()},
            "approved": approved,
            "approve_count": approvals,
            "reject_count": rejections,
        }
    return None


def process_vote_result(game: GameState, approved: bool) -> str:
    """Returns: 'mission', 'next_proposal', or 'evil_wins_by_rejection'."""
    if approved:
        game.consecutive_rejections = 0
        game.phase = GamePhase.MISSION
        return "mission"
    else:
        game.consecutive_rejections += 1
        if game.consecutive_rejections >= 5:
            game.phase = GamePhase.GAME_OVER
            game.winner = "evil"
            game.win_reason = "rejections"
            return "evil_wins_by_rejection"
        # Advance leader
        game.current_leader_index = (game.current_leader_index + 1) % len(
            game.player_order
        )
        game.phase = GamePhase.TEAM_PROPOSAL
        return "next_proposal"


# ---------------------------------------------------------------------------
# Mission execution
# ---------------------------------------------------------------------------


def record_mission_card(game: GameState, player_id: str, card: str) -> dict | None:
    """Record a mission card. Returns result dict when all have played, else None.
    Raises ValueError if card is invalid."""
    player = game.players[player_id]
    if player_id not in game.proposed_team:
        raise ValueError("Not on the mission team")
    if player_id in game.mission_cards:
        raise ValueError("Already played a card")
    if card not in ("success", "fail"):
        raise ValueError("Card must be 'success' or 'fail'")
    if player.team == Team.GOOD and card == "fail":
        raise ValueError("Good players must play success")
    game.mission_cards[player_id] = card
    if len(game.mission_cards) == len(game.proposed_team):
        return evaluate_mission(game)
    return None


def evaluate_mission(game: GameState) -> dict:
    cards = list(game.mission_cards.values())
    fail_count = cards.count("fail")
    fail_threshold = 2 if game.requires_double_fail() else 1
    passed = fail_count < fail_threshold
    return {
        "passed": passed,
        "fail_count": fail_count,
        "success_count": cards.count("success"),
        "total_cards": len(cards),
        "cards_shuffled": secure_random.sample(
            cards, len(cards)
        ),  # shuffled for reveal
    }


def process_mission_result(game: GameState, passed: bool) -> str:
    """Returns: 'assassin_phase', 'evil_wins', or 'next_mission'."""
    game.mission_results.append("pass" if passed else "fail")
    good = game.good_wins()
    evil = game.evil_wins_count()

    if good >= 3:
        return "assassin_phase"
    elif evil >= 3:
        game.winner = "evil"
        game.win_reason = "missions"
        return "evil_wins"
    else:
        return "next_mission"


# ---------------------------------------------------------------------------
# Assassin phase
# ---------------------------------------------------------------------------


def get_assassin(game: GameState) -> PlayerInfo | None:
    for p in game.players.values():
        if p.role == Role.ASSASSIN:
            return p
    return None


def get_assassin_targets(game: GameState) -> list[PlayerInfo]:
    """Return the Good players the Assassin may name as Merlin."""
    return [player for player in game.players.values() if player.team == Team.GOOD]


def process_assassination(game: GameState, target_player_id: str) -> dict:
    target = game.players.get(target_player_id)
    if not target:
        raise ValueError("Unknown player")
    if target.team != Team.GOOD:
        raise ValueError("The Assassin must target a Good player")
    was_merlin = target.role == Role.MERLIN
    if was_merlin:
        game.winner = "evil"
        game.win_reason = "assassination"
    else:
        game.winner = "good"
        game.win_reason = "assassination_failed"
    game.assassin_target = target_player_id
    game.phase = GamePhase.GAME_OVER
    return {
        "target_name": target.name,
        "was_merlin": was_merlin,
        "winner": game.winner,
        "win_reason": game.win_reason,
    }


def get_game_summary(game: GameState) -> dict:
    return {
        "winner": game.winner,
        "win_reason": game.win_reason,
        "roles": {
            p.name: {"role": p.role, "team": p.team} for p in game.players.values()
        },
        "mission_results": game.mission_results,
        "mission_history": game.mission_history,
        "proposal_history": game.proposal_history,
        "player_order": [game.players[pid].name for pid in game.player_order],
    }


# ---------------------------------------------------------------------------
# Reconnection state snapshot
# ---------------------------------------------------------------------------


def build_state_snapshot(game: GameState, player_id: str) -> dict:
    """Full state snapshot for a reconnecting player."""
    player = game.players.get(player_id)
    snap = {
        "phase": game.phase,
        "code": game.code,
        "players": game.public_players(),
        "player_order": [game.players[pid].name for pid in game.player_order],
        "player_name_to_id": {
            game.players[pid].name: pid for pid in game.player_order
        },
        "current_mission": game.current_mission,
        "mission_results": game.mission_results,
        "mission_history": game.mission_history,
        "consecutive_rejections": game.consecutive_rejections,
        "game_started_at": game.started_at,
        "mission_sizes": MISSION_SIZES.get(game.player_count(), []),
        "settings": {
            "discussion_time": game.discussion_time,
            "proposal_time": game.proposal_time,
        },
        "timer_kind": game.timer_kind,
        "timer_remaining": (
            max(0, int(game.timer_deadline - time.time() + 0.999))
            if game.timer_deadline
            else None
        ),
    }
    if game.player_count() in MISSION_SIZES:
        snap["mission_size"] = game.mission_size()
    if player:
        snap["my_player_id"] = player_id
        snap["my_name"] = player.name
        # Host authority belongs only to the separately authenticated display.
        snap["is_host"] = False
        if player.role:
            snap["my_role"] = player.role
            snap["my_team"] = player.team
            snap["night_info"] = get_night_phase_info(game, player_id)
        snap["my_vote"] = game.votes.get(player_id)
        snap["my_mission_card"] = game.mission_cards.get(player_id)
        snap["night_acknowledged"] = player_id in game.night_acks

    leader = game.current_leader()
    if leader:
        snap["current_leader"] = leader.name
        snap["current_leader_id"] = leader.player_id
        snap["i_am_leader"] = player_id == leader.player_id if player else False

    if game.proposed_team:
        snap["proposed_team"] = [
            game.players[pid].name for pid in game.proposed_team if pid in game.players
        ]
        snap["proposed_team_ids"] = game.proposed_team
        # Client renderers use the event name for this same public value.
        snap["team"] = snap["proposed_team"]
        snap["team_ids"] = game.proposed_team

    if game.phase == GamePhase.ASSASSIN_PHASE:
        assassin = get_assassin(game)
        snap["assassin_name"] = assassin.name if assassin else "Unknown"
        if player and assassin and player_id == assassin.player_id:
            snap.update(
                {
                    "assassin_id": assassin.player_id,
                    "targets": [
                        {"name": p.name, "player_id": p.player_id}
                        for p in get_assassin_targets(game)
                    ],
                }
            )

    if game.phase == GamePhase.GAME_OVER:
        snap["summary"] = get_game_summary(game)

    if game.phase == GamePhase.MISSION_REVEAL and game.mission_history:
        snap["latest_mission"] = game.mission_history[-1]

    return snap
