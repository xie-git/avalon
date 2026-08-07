from game_logic import (
    GamePhase,
    GameState,
    Role,
    Team,
    add_player,
    assign_roles,
    generate_game_code,
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
