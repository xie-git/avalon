"""The pre-rendered narrator voice must stay in sync with narrator.py."""

import json
import random
import sys
from pathlib import Path

import narrator

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools" / "voice"))
import script  # noqa: E402


def test_every_narrator_line_has_a_name_free_voice():
    assert set(script.NARRATOR_PREMISES) == set(narrator.TRIGGERS)
    assert len(script.NARRATOR_DELIVERIES) == len(narrator._DELIVERIES)
    assert {k: len(v) for k, v in script.NARRATOR_FOLLOWUPS.items()} == {
        k: len(v) for k, v in narrator.DOUBLE_ACT_FOLLOWUPS.items()
    }
    for text in script.all_clips().values():
        assert "{" not in text and "}" not in text


def test_narrator_messages_reference_existing_clips():
    clips = script.all_clips()
    rng = random.Random(7)
    for trigger_id in narrator.TRIGGERS:
        for _ in range(6):
            runtime = narrator.new_runtime()
            message = narrator._line(trigger_id, runtime, rng)
            assert message["voice"] and all(clip in clips for clip in message["voice"])
            assert message["voice"][0] == f"n{trigger_id}"


def test_manifest_covers_every_clip_with_a_file():
    manifest_path = ROOT / "static" / "voice" / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    clips = script.all_clips()
    assert set(manifest["clips"]) == set(clips)
    for clip_id, entry in manifest["clips"].items():
        assert entry["t"] == clips[clip_id]
        assert (ROOT / "static" / "voice" / manifest["voice"] / f"{clip_id}.mp3").is_file()
    for cue, takes in script.EVENT_CUES.items():
        assert manifest["cues"][cue] == [f"e.{cue}.{i}" for i in range(1, len(takes) + 1)]
