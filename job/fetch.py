"""Fetch the caption-sample sources on the runner and transcribe the episode clip."""
import json
import os
import re
import subprocess
import sys
import urllib.request
import xml.etree.ElementTree as ET

job = json.load(open("job/job.json"))
os.makedirs("results", exist_ok=True)
UA = {"User-Agent": "Mozilla/5.0 (caption-sample)"}
MRSS = "{http://search.yahoo.com/mrss/}"


def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=180).read()


def run(cmd):
    print("+", " ".join(cmd[:6]), "...", flush=True)
    subprocess.run(cmd, check=True)


def probe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", path],
        capture_output=True, text=True, check=True,
    ).stdout
    data = json.loads(out)
    stream = data["streams"][0]
    return {"width": stream["width"], "height": stream["height"], "duration": float(data["format"]["duration"])}


# 1. The vertical short, as published (already fetched by the first run).
if not os.path.exists("results/short.mp4"):
    open("results/short.mp4", "wb").write(get(job["short_url"]))
print("short", probe("results/short.mp4"), flush=True)

# 2. The episodes: full-HD ones.
root = ET.fromstring(get(job["episodes_feed"]).decode("utf-8", "replace"))
episodes = []
for item in root.iter("item"):
    title = (item.findtext("title") or "").strip()
    for content in item.iter(MRSS + "content"):
        url = content.get("url") or ""
        if ".mp4" not in url and "mp4" not in (content.get("type") or ""):
            continue
        episodes.append({
            "title": title,
            "url": url,
            "width": int(float(content.get("width") or 0)),
            "height": int(float(content.get("height") or 0)),
            "duration": float(content.get("duration") or 0),
        })
        break
full_hd = [ep for ep in episodes if ep["width"] >= 1280] or episodes
print(len(episodes), "episodes,", len(full_hd), "full HD", flush=True)
json.dump(episodes, open("results/episodes.json", "w"), indent=1)

fallback = next((ep for ep in full_hd if "Golden Hot Dog" in ep["title"]), full_hd[0])
run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-ss", "60", "-i", fallback["url"], "-t", "75",
     "-map", "0:v:0", "-map", "0:a:0", "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p",
     "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "results/fallback_clip.mp4"])
json.dump({"episode": fallback, "clip_start": 60, "clip_duration": 75}, open("results/fallback_clip.json", "w"), indent=1)
print("fallback clip", probe("results/fallback_clip.mp4"), os.path.getsize("results/fallback_clip.mp4"), flush=True)

from faster_whisper import WhisperModel  # noqa: E402

scan_model = WhisperModel("small.en", device="cpu", compute_type="int8")


def transcribe(model, path, offset=0.0):
    segments, _info = model.transcribe(path, language="en", word_timestamps=True, vad_filter=True, beam_size=5, condition_on_previous_text=False)
    out = []
    for seg in segments:
        out.append({
            "start": round(seg.start + offset, 2),
            "end": round(seg.end + offset, 2),
            "text": seg.text.strip(),
            "logprob": round(seg.avg_logprob, 3),
            "no_speech": round(seg.no_speech_prob, 3),
            "words": [{"w": w.word, "s": round(w.start + offset, 2), "e": round(w.end + offset, 2)} for w in (seg.words or [])],
        })
    return out


def best_window(segments):
    best = None
    for i in range(len(segments)):
        if not re.match(r"^[A-Z\"']", segments[i]["text"]):
            continue
        words = 0
        for j in range(i, len(segments)):
            if j > i and segments[j]["start"] - segments[j - 1]["end"] > 1.4:
                break
            if segments[j]["logprob"] < -0.9 or segments[j]["no_speech"] > 0.5:
                break
            words += len(segments[j]["text"].split())
            dur = segments[j]["end"] - segments[i]["start"]
            if dur > job["clip_max"]:
                break
            if dur >= job["clip_min"] and re.search(r"[.!?]$", segments[j]["text"]):
                score = words / dur
                if not best or score > best["score"]:
                    best = {"score": round(score, 3), "start": segments[i]["start"], "end": segments[j]["end"], "i": i, "j": j}
    return best


chosen = None
for index, ep in enumerate(full_hd[:6]):
    print("scanning", ep["title"], flush=True)
    try:
        run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-ss", str(job["scan_from"]), "-t", str(job["scan_seconds"]), "-i", ep["url"], "-vn", "-ac", "1", "-ar", "16000", "results/scan.wav"])
    except subprocess.CalledProcessError:
        continue
    segments = transcribe(scan_model, "results/scan.wav", offset=job["scan_from"])
    window = best_window(segments)
    json.dump({"episode": ep, "segments": segments, "window": window}, open(f"results/scan_{index}.json", "w"), indent=1)
    print("window", window, flush=True)
    if window and window["score"] >= 2.2:
        chosen = {"episode": ep, "window": window}
        break
if os.path.exists("results/scan.wav"):
    os.remove("results/scan.wav")
if not chosen:
    sys.exit("no window with continuous speech found")

start = max(0.0, chosen["window"]["start"] - 0.4)
duration = chosen["window"]["end"] - start + 0.8
run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{start:.2f}", "-i", chosen["episode"]["url"], "-t", f"{duration:.2f}",
     "-map", "0:v:0", "-map", "0:a:0", "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p",
     "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "results/episode_clip.mp4"])
print("clip", probe("results/episode_clip.mp4"), os.path.getsize("results/episode_clip.mp4"), flush=True)

# The clip itself, transcribed again by the full model on its own timeline.
try:
    full = WhisperModel("large-v3", device="cpu", compute_type="int8")
except Exception as error:  # noqa: BLE001
    print("large-v3 unavailable:", error, flush=True)
    full = WhisperModel("medium.en", device="cpu", compute_type="int8")
run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", "results/episode_clip.mp4", "-vn", "-ac", "1", "-ar", "16000", "results/clip.wav"])
clip_segments = transcribe(full, "results/clip.wav")
os.remove("results/clip.wav")
json.dump({"episode": chosen["episode"], "clip_start": start, "clip_duration": duration, "segments": clip_segments}, open("results/clip_transcript.json", "w"), indent=1)
print("done", flush=True)
