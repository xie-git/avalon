import pytest

from game_logic import (
    MISSION_SIZES,
    PLAYER_COUNT_ROLES,
    GamePhase,
    GameState,
    Role,
    Team,
    add_player,
    assign_roles,
    evaluate_mission,
    generate_game_code,
    get_assassin_targets,
    get_night_phase_info,
    process_assassination,
    process_mission_result,
    process_vote_result,
    record_mission_card,
    record_vote,
    validate_team_proposal,
)


def make_game(count=6):
    game = GameState("ABCDEF")
    for index in range(count):
        add_player(game, f"Player {index}", f"player-{index}")
    return game


def test_room_codes_are_four_characters_and_unique():
    codes = set()
    for _ in range(200):
        code = generate_game_code(codes)
        assert len(code) == 4
        assert code not in codes
        codes.add(code)


def test_role_assignment_has_expected_teams():
    game = make_game(6)
    assign_roles(game)
    assert game.phase == GamePhase.ROLE_ASSIGNMENT
    assert sum(player.team == Team.GOOD for player in game.players.values()) == 4
    assert sum(player.team == Team.EVIL for player in game.players.values()) == 2
    assert sum(player.role == Role.MERLIN for player in game.players.values()) == 1
    assert sum(player.role == Role.ASSASSIN for player in game.players.values()) == 1


@pytest.mark.parametrize(
    ("count", "good_count", "evil_count", "mission_sizes"),
    [
        (6, 4, 2, [2, 3, 4, 3, 4]),
        (7, 4, 3, [2, 3, 3, 4, 4]),
        (8, 5, 3, [3, 4, 4, 5, 5]),
        (9, 6, 3, [3, 4, 4, 5, 5]),
        (10, 6, 4, [3, 4, 4, 5, 5]),
    ],
)
def test_every_supported_player_count_matches_rulebook(
    count, good_count, evil_count, mission_sizes
):
    game = make_game(count)
    assign_roles(game)

    assert len(PLAYER_COUNT_ROLES[count][0]) == good_count
    assert len(PLAYER_COUNT_ROLES[count][1]) == evil_count
    assert sum(p.team == Team.GOOD for p in game.players.values()) == good_count
    assert sum(p.team == Team.EVIL for p in game.players.values()) == evil_count
    assert sum(p.role == Role.MERLIN for p in game.players.values()) == 1
    assert sum(p.role == Role.ASSASSIN for p in game.players.values()) == 1
    assert MISSION_SIZES[count] == mission_sizes

    for mission_index in range(5):
        game.current_mission = mission_index
        assert game.mission_size() == mission_sizes[mission_index]
        assert game.requires_double_fail() is (
            count >= 7 and mission_index == 3
        )


def test_special_roles_receive_only_rulebook_night_knowledge():
    game = make_game(10)
    roles = [role for team in PLAYER_COUNT_ROLES[10] for role in team]
    for player_id, role in zip(game.player_order, roles):
        player = game.players[player_id]
        player.role = role
        player.team = Team.GOOD if role in {
            Role.MERLIN,
            Role.PERCIVAL,
            Role.LOYAL_SERVANT,
        } else Team.EVIL

    by_role = {player.role: player for player in game.players.values()}
    merlin_info = get_night_phase_info(game, by_role[Role.MERLIN].player_id)
    assert set(merlin_info["sees"]) == {
        by_role[Role.ASSASSIN].name,
        by_role[Role.MORGANA].name,
        by_role[Role.OBERON].name,
    }

    percival_info = get_night_phase_info(game, by_role[Role.PERCIVAL].player_id)
    assert set(percival_info["sees"]) == {
        by_role[Role.MERLIN].name,
        by_role[Role.MORGANA].name,
    }

    known_evil = {Role.ASSASSIN, Role.MORGANA, Role.MORDRED}
    for role in known_evil:
        info = get_night_phase_info(game, by_role[role].player_id)
        assert set(info["sees"]) == {
            by_role[other].name for other in known_evil if other != role
        }
    assert get_night_phase_info(game, by_role[Role.OBERON].player_id)["sees"] == []


def test_regular_minion_knows_other_non_oberon_evil_players():
    game = make_game(7)
    roles = [role for team in PLAYER_COUNT_ROLES[7] for role in team]
    for player_id, role in zip(game.player_order, roles):
        player = game.players[player_id]
        player.role = role
        player.team = Team.GOOD if role in {
            Role.MERLIN,
            Role.PERCIVAL,
            Role.LOYAL_SERVANT,
        } else Team.EVIL
    by_role = {player.role: player for player in game.players.values()}
    minion_info = get_night_phase_info(
        game, by_role[Role.MINION_OF_MORDRED].player_id
    )
    assert set(minion_info["sees"]) == {
        by_role[Role.ASSASSIN].name,
        by_role[Role.MORGANA].name,
    }


def test_vote_and_mission_flow():
    game = make_game(6)
    assign_roles(game)
    game.phase = GamePhase.TEAM_VOTE
    result = None
    for player_id in game.player_order:
        result = record_vote(game, player_id, "approve")
    assert result["approved"] is True
    assert process_vote_result(game, True) == "mission"

    game.proposed_team = game.player_order[:2]
    validate_team_proposal(game, game.proposed_team)
    for player_id in game.proposed_team:
        game.players[player_id].team = Team.GOOD
    assert record_mission_card(game, game.proposed_team[0], "success") is None
    mission = record_mission_card(game, game.proposed_team[1], "success")
    assert mission["passed"] is True
    assert process_mission_result(game, True) == "next_mission"


def test_tied_team_vote_is_rejected_and_five_rejections_end_game():
    game = make_game(6)
    game.phase = GamePhase.TEAM_VOTE
    result = None
    for index, player_id in enumerate(game.player_order):
        result = record_vote(game, player_id, "approve" if index < 3 else "reject")
    assert result["approved"] is False

    for rejection in range(1, 6):
        outcome = process_vote_result(game, False)
        if rejection < 5:
            assert outcome == "next_proposal"
            game.phase = GamePhase.TEAM_VOTE
        else:
            assert outcome == "evil_wins_by_rejection"
            assert game.winner == "evil"


@pytest.mark.parametrize(
    ("count", "mission_index", "cards", "passed"),
    [
        (6, 3, ["fail", "success", "success"], False),
        (7, 3, ["fail", "success", "success", "success"], True),
        (7, 3, ["fail", "fail", "success", "success"], False),
        (7, 4, ["fail", "success", "success", "success"], False),
        (10, 3, ["fail", "success", "success", "success", "success"], True),
        (10, 3, ["fail", "fail", "success", "success", "success"], False),
    ],
)
def test_rulebook_double_fail_exception(count, mission_index, cards, passed):
    game = make_game(count)
    game.current_mission = mission_index
    game.proposed_team = game.player_order[: len(cards)]
    game.mission_cards = dict(zip(game.proposed_team, cards))
    assert evaluate_mission(game)["passed"] is passed


def test_good_player_cannot_fail_and_assassin_result_is_final():
    game = make_game(6)
    assign_roles(game)
    good = next(player for player in game.players.values() if player.team == Team.GOOD)
    game.phase = GamePhase.MISSION
    game.proposed_team = [good.player_id]
    try:
        record_mission_card(game, good.player_id, "fail")
    except ValueError as error:
        assert "must play success" in str(error)
    else:
        raise AssertionError("good player was allowed to fail a mission")

    merlin = next(
        player for player in game.players.values() if player.role == Role.MERLIN
    )
    result = process_assassination(game, merlin.player_id)
    assert result["winner"] == "evil"
    assert game.phase == GamePhase.GAME_OVER


def test_assassin_may_target_only_good_players():
    game = make_game(10)
    assign_roles(game)
    targets = get_assassin_targets(game)
    assert len(targets) == 6
    assert all(player.team == Team.GOOD for player in targets)

    evil = next(player for player in game.players.values() if player.team == Team.EVIL)
    with pytest.raises(ValueError, match="must target a Good player"):
        process_assassination(game, evil.player_id)
