"""Transcribe results/fallback_clip.mp4 with whisper large-v3 (word timestamps)."""
import json
import subprocess
import wave

import numpy as np
from faster_whisper import WhisperModel

subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", "results/fallback_clip.mp4", "-vn", "-ac", "1", "-ar", "16000", "results/fallback.wav"], check=True)
with wave.open("results/fallback.wav", "rb") as handle:
    audio = np.frombuffer(handle.readframes(handle.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0

out = {}
for name in ["large-v3", "large-v3-turbo"]:
    try:
        model = WhisperModel(name, device="cpu", compute_type="int8")
    except Exception as error:  # noqa: BLE001
        print(name, "unavailable:", error, flush=True)
        continue
    segments, _info = model.transcribe(audio, language="en", word_timestamps=True, vad_filter=True, beam_size=5, condition_on_previous_text=False)
    out[name] = [
        {
            "start": round(seg.start, 2), "end": round(seg.end, 2), "text": seg.text.strip(),
            "logprob": round(seg.avg_logprob, 3), "no_speech": round(seg.no_speech_prob, 3),
            "words": [{"w": w.word, "s": round(w.start, 2), "e": round(w.end, 2)} for w in (seg.words or [])],
        }
        for seg in segments
    ]
    print(name, len(out[name]), "segments", flush=True)
    json.dump(out, open("results/fallback_transcript.json", "w"), indent=1)
    break
print("done", flush=True)
