import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("APP_ENV", "development")

import server  # noqa: E402


@pytest.fixture(autouse=True)
def reset_server_state():
    server.app.config["TESTING"] = True
    server.games.clear()
    server.game_activity.clear()
    server.sid_to_info.clear()
    server.session_tokens.clear()
    server.connected_sids.clear()
    server.rate_windows.clear()
    yield
    server.games.clear()
    server.game_activity.clear()
    server.sid_to_info.clear()
    server.session_tokens.clear()
    server.connected_sids.clear()
    server.rate_windows.clear()


@pytest.fixture
def socket_client():
    client = server.socketio.test_client(server.app)
    assert client.is_connected()
    yield client
    if client.is_connected():
        client.disconnect()


def received(client, event):
    return [
        packet["args"][0] for packet in client.get_received() if packet["name"] == event
    ]


@pytest.fixture
def create_game():
    def factory(client):
        client.emit("create_game")
        packets = client.get_received()
        created = [
            packet["args"][0] for packet in packets if packet["name"] == "game_created"
        ]
        assert len(created) == 1
        return created[0]

    return factory
