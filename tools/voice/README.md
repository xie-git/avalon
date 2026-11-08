# Court Narrator voice pipeline

The narrator's voice is pre-rendered; nothing is generated while a game runs.

- `script.py` — every spoken line: event cues (several takes each), name-free
  spoken versions of the text narrator in `narrator.py`
  (`n<trigger>`, `d<delivery>`, `n<trigger>f<followup>`) and the standalone
  lines for triggers 95+ (`n<trigger>v<line>`, imported from
  `narrator.EXTRA_LINES`, so chat text and voice are identical).
- `render_chatterbox.py` — the shipped voice. Renders every line with
  Chatterbox TTS (Resemble AI, MIT) on a CUDA GPU, cloning the timbre of a
  short reference clip of the original Kokoro "court" voice. Each line gets two
  takes (three if both disappoint); Whisper checks the words and UTMOS rates
  naturalness, and only the best take is kept (`scores.json` records why).
- `generate.py --from-wav DIR` — applies the shared processing (trim, low cut,
  short great-hall echo, loudness) to those WAVs and writes
  `static/voice/court/*.mp3` + `static/voice/manifest.json`.
- `generate.py` without `--from-wav` is the original CPU-only Kokoro-82M
  renderer, kept as a fallback (`/home/xie/avalon-voice-tools` on VM 103).

## Regenerating

1. GPU render (xiedesktop, RTX 5080; venv in `D:\avalon-voice`, PyTorch
   2.8 cu128 + `chatterbox-tts` 0.1.7 installed with `--no-deps`, plus
   `openai-whisper`, `jiwer`; reference clip `refs\ref-court.wav`):

   ```bat
   cd /d D:\avalon-voice
   venv\Scripts\python repo\tools\voice\render_chatterbox.py --ref refs\ref-court.wav --out render\court [--only CLIP_ID ...]
   ```

   Copy `narrator.py` and `tools/voice/*.py` into `D:\avalon-voice\repo` first.
   Unchanged lines are skipped. A full render of ~450 lines takes about an hour.

2. Copy `render\court\*.wav` to the repository host and process (VM 103):

   ```bash
   cd /home/xie/avalon
   docker run --rm --user 1000:1000 -v "$PWD:/repo" -v /path/to/wavs:/wavs:ro \
     avalon-voice:1 python /repo/tools/voice/generate.py --from-wav /wavs
   ```

3. Bump `ASSET_VERSION` in `static/js/showtime.js` (the manifest URL uses it);
   clip URLs already carry each clip's hash.

Spoken lines must never contain player names or secret information. The
clients choose clips only from public events.
