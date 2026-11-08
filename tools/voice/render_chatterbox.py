"""Render the Court Narrator with Chatterbox (MIT) on a CUDA GPU, best-of-N.

This is the natural-sounding voice pass.  Each line is rendered as two (or,
when both disappoint, three) candidate takes; every take is checked with
Whisper (does it say the words?) and UTMOS (does it sound like clean, human
speech?) and only the best one is kept.  Output is plain WAV plus
``scores.json``; ``generate.py --from-wav`` then applies the shared audio
processing and writes ``static/voice``.

    python tools/voice/render_chatterbox.py --ref refs/ref-court.wav --out render/court

Requirements (separate GPU venv, not the app image): torch with CUDA,
chatterbox-tts, openai-whisper, jiwer, soundfile and the SpeechMOS UTMOS hub
model.  See README.md.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from script import all_clips  # noqa: E402

# (exaggeration, cfg_weight, temperature).  A touch more exaggeration and a
# lower CFG weight give the theatrical, sassy delivery the narrator needs.
CANDIDATES = ((0.65, 0.4, 0.8), (0.75, 0.32, 0.85), (0.58, 0.45, 0.75))
SETTINGS_VERSION = "cb1"
GOOD_ENOUGH = 4.25


def speakable(text: str) -> str:
    text = text.replace("–", "-").replace("—", ", ").replace("…", "...")
    return re.sub(r"\s+", " ", text).strip()


def words(text: str) -> str:
    text = text.lower().replace("-", " ").replace("–", " ")
    return " ".join(re.sub(r"[^a-z0-9' ]", " ", text).replace("'", "").split())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ref", required=True, help="Reference voice WAV (10-15 s)")
    parser.add_argument("--out", required=True)
    parser.add_argument("--only", nargs="*")
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()

    import jiwer
    import numpy as np
    import soundfile as sf
    import torch
    import torchaudio
    import whisper
    from chatterbox.tts import ChatterboxTTS

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    scores_path = out / "scores.json"
    scores = json.loads(scores_path.read_text()) if scores_path.exists() else {}
    ref_hash = hashlib.sha256(Path(args.ref).read_bytes()).hexdigest()[:12]

    device = "cuda"
    model = ChatterboxTTS.from_pretrained(device)
    model.prepare_conditionals(args.ref, exaggeration=CANDIDATES[0][0])
    asr = whisper.load_model("small.en", device=device)
    mos = torch.hub.load("tarepan/SpeechMOS:v1.2.0", "utmos22_strong", trust_repo=True).to(device).eval()

    def judge(wav: torch.Tensor, text: str) -> dict:
        w16 = torchaudio.functional.resample(wav, model.sr, 16000)
        with torch.no_grad():
            quality = float(mos(w16.to(device), 16000).item())
        heard = asr.transcribe(w16.squeeze(0).numpy().astype(np.float32), language="en", fp16=True)["text"]
        wer = jiwer.wer(words(text), words(heard)) if words(heard) else 1.0
        seconds = wav.shape[-1] / model.sr
        pace = len(text) / max(seconds, 0.1)  # characters per second
        penalty = max(0.0, 9.5 - pace) * 0.15 + max(0.0, pace - 21) * 0.15
        return {
            "mos": round(quality, 3), "wer": round(wer, 3), "sec": round(seconds, 2),
            "cps": round(pace, 1), "heard": heard.strip(),
            "score": round(quality - 4.0 * wer - penalty, 3),
        }

    clips = all_clips()
    wanted = [cid for cid in clips if not args.only or cid in args.only]
    todo = []
    for clip_id in wanted:
        text = clips[clip_id]
        digest = hashlib.sha256(f"{SETTINGS_VERSION}|{ref_hash}|{text}".encode()).hexdigest()[:16]
        if scores.get(clip_id, {}).get("h") == digest and (out / f"{clip_id}.wav").exists():
            continue
        todo.append((clip_id, text, digest))
    if args.limit:
        todo = todo[: args.limit]
    print(f"{len(todo)} clip(s) to render of {len(wanted)}", flush=True)

    started = time.time()
    for done, (clip_id, text, digest) in enumerate(todo, 1):
        seed = int(hashlib.sha256(clip_id.encode()).hexdigest()[:8], 16)
        takes = []
        for index, (exaggeration, cfg, temperature) in enumerate(CANDIDATES):
            if index == 2 and max(t["score"] for t in takes) >= GOOD_ENOUGH:
                break
            torch.manual_seed(seed + index)
            wav = model.generate(
                speakable(text), exaggeration=exaggeration, cfg_weight=cfg, temperature=temperature,
            ).cpu()
            verdict = judge(wav, text)
            verdict["take"] = index
            takes.append(verdict | {"wav": wav})
        best = max(takes, key=lambda t: t["score"])
        sf.write(out / f"{clip_id}.wav", best["wav"].squeeze(0).numpy(), model.sr)
        scores[clip_id] = {
            "t": text, "h": digest,
            **{k: v for k, v in best.items() if k != "wav"},
            "takes": [{k: v for k, v in t.items() if k not in {"wav", "heard"}} for t in takes],
        }
        elapsed = time.time() - started
        print(
            f"[{done}/{len(todo)}] {clip_id} take{best['take']} mos={best['mos']} "
            f"wer={best['wer']} {best['sec']}s  eta={elapsed / done * (len(todo) - done) / 60:.0f}m",
            flush=True,
        )
        if done % 10 == 0 or done == len(todo):
            scores_path.write_text(json.dumps(scores, indent=1, ensure_ascii=False))
    for stale in {p.stem for p in out.glob("*.wav")} - set(clips):
        (out / f"{stale}.wav").unlink()
        scores.pop(stale, None)
    scores_path.write_text(json.dumps(scores, indent=1, ensure_ascii=False))
    print("DONE", round((time.time() - started) / 60, 1), "minutes", flush=True)


if __name__ == "__main__":
    main()
