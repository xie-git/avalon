# Court Narrator voice pipeline

The narrator's voice is pre-rendered; nothing is generated while a game runs.

- `script.py` — every spoken line: event cues (several takes each) plus
  name-free spoken versions of the text narrator in `narrator.py`
  (`n<trigger>`, `d<delivery>`, `n<trigger>f<followup>`).
- `generate.py` — renders the script with Kokoro-82M v1.0 (Apache-2.0,
  offline) into `static/voice/court/*.mp3` and `static/voice/manifest.json`.
  Unchanged lines are skipped, so editing one line re-renders only that clip.

## Regenerating (VM 103)

The helper image and model files live outside the repository in
`/home/xie/avalon-voice-tools` (`Dockerfile`, `models/kokoro-v1.0.onnx`,
`models/voices-v1.0.bin`).

```bash
cd /home/xie/avalon
nice -n 15 docker run --rm --cpus 1.5 --user 1000:1000 \
  -v "$PWD:/repo" -v /home/xie/avalon-voice-tools/models:/models:ro \
  avalon-voice:1 python /repo/tools/voice/generate.py [--only CLIP_ID ...]
```

A full render takes about 40 minutes on 1.5 vCPU. Voice settings (blend of
British voices, speed) and audio processing are in `VOICES`/`FILTER` in
`generate.py`; changing them re-renders everything. Clip URLs carry the clip
hash, so browsers fetch changed clips despite immutable caching.

Spoken lines must never contain player names or secret information. The
clients choose clips only from public events.
