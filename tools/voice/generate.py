"""Pre-render the Court Narrator voice clips with Kokoro (offline TTS).

Run inside the helper image described in tools/voice/README.md:

    docker run --rm --cpus 1.5 -v "$PWD:/repo" -v "$MODELS:/models" \
        avalon-voice:1 python /repo/tools/voice/generate.py

Clips are written to static/voice/<voice-id>/<clip>.mp3 together with
static/voice/manifest.json.  Unchanged clips (same text, voice and processing)
are skipped, so editing one line only re-renders that line.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from script import EVENT_CUES, NARRATOR_FOLLOWUPS, all_clips  # noqa: E402

# A blend of two British Kokoro voices gives a warmer, theatrical narrator.
VOICES = {
    "court": {"blend": {"bm_george": 0.6, "bm_fable": 0.4}, "speed": 0.96},
}
# Mild loudness normalisation, a short "great hall" echo and a gentle low cut.
TRIM = "silenceremove=start_periods=1:start_threshold=-55dB:start_silence=0.05"
FILTER = (
    f"{TRIM},areverse,{TRIM},areverse,"
    "highpass=f=70,"
    "aecho=0.85:0.6:38|74:0.16|0.08,"
    "loudnorm=I=-16:TP=-1.5:LRA=9"
)
PROCESS_VERSION = "3"


def clip_hash(voice_id: str, text: str) -> str:
    voice = json.dumps(VOICES[voice_id], sort_keys=True)
    return hashlib.sha256(f"{PROCESS_VERSION}|{voice}|{FILTER}|{text}".encode()).hexdigest()[:16]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", default="/models")
    parser.add_argument("--voice", default="court", choices=sorted(VOICES))
    parser.add_argument("--only", nargs="*", help="Clip ids to render (default: all)")
    args = parser.parse_args()

    from kokoro_onnx import Kokoro

    kokoro = Kokoro(f"{args.models}/kokoro-v1.0.onnx", f"{args.models}/voices-v1.0.bin")
    config = VOICES[args.voice]
    style = sum(weight * kokoro.get_voice_style(name) for name, weight in config["blend"].items())

    out_dir = ROOT / "static" / "voice" / args.voice
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = ROOT / "static" / "voice" / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    previous = manifest.get("clips", {})

    clips = all_clips()
    wanted = set(args.only or clips)
    entries: dict[str, dict] = {}
    rendered = 0
    for clip_id, text in clips.items():
        digest = clip_hash(args.voice, text)
        target = out_dir / f"{clip_id}.mp3"
        old = previous.get(clip_id)
        if clip_id not in wanted or (old and old.get("h") == digest and target.exists()):
            if old:
                entries[clip_id] = old
            continue
        samples, rate = kokoro.create(text, voice=style, speed=config["speed"], lang="en-gb")
        samples = np.concatenate([np.zeros(int(rate * 0.05), dtype=samples.dtype), samples])
        with tempfile.NamedTemporaryFile(suffix=".wav") as wav:
            sf.write(wav.name, samples, rate)
            subprocess.run(
                [
                    "ffmpeg", "-loglevel", "error", "-y", "-i", wav.name, "-af", FILTER,
                    "-ar", "24000", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "56k", str(target),
                ],
                check=True,
            )
        duration = float(
            subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(target)],
                check=True, capture_output=True, text=True,
            ).stdout.strip()
        )
        entries[clip_id] = {"t": text, "ms": round(duration * 1000), "h": digest}
        rendered += 1
        print(f"[{rendered}] {clip_id} {duration:.1f}s", flush=True)
        if rendered % 10 == 0:
            write_manifest(manifest_path, args.voice, entries | {
                key: value for key, value in previous.items() if key not in entries
            })

    for stale in set(p.stem for p in out_dir.glob("*.mp3")) - set(clips):
        (out_dir / f"{stale}.mp3").unlink()
    write_manifest(manifest_path, args.voice, entries)
    total = sum(item["ms"] for item in entries.values()) / 1000
    print(f"Rendered {rendered} clip(s); {len(entries)} total, {total / 60:.1f} minutes of audio.")


def write_manifest(manifest_path: Path, voice: str, entries: dict[str, dict]) -> None:
    cues = {cue: [f"e.{cue}.{i}" for i in range(1, len(takes) + 1)] for cue, takes in EVENT_CUES.items()}
    cues.update({
        f"n{trigger}f": [f"n{trigger}f{i}" for i in range(1, len(takes) + 1)]
        for trigger, takes in NARRATOR_FOLLOWUPS.items()
    })
    manifest = {
        "voice": voice,
        "base": f"/static/voice/{voice}/",
        "engine": "Kokoro-82M v1.0 (Apache-2.0), offline pre-render",
        "clips": dict(sorted(entries.items())),
        "cues": cues,
    }
    manifest_path.write_text(json.dumps(manifest, indent=1, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
