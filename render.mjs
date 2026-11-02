/**
 * Subtitle renderer worker (runs inside a GitHub Actions job).
 *
 * Reads the job from JOB_JSON, does one of two tasks, uploads the result to
 * Cloudflare R2 and reports back to VidoLeads:
 *
 *   audio  → the video's audio track as a small MP3 (for transcription)
 *   burn   → one MP4 per language with the subtitles burned in (FFmpeg +
 *            libass), plus the WebVTT sidecar
 *
 * Job shape (prepared by VidoLeads):
 * {
 *   id: "<item id>:<task>:<rev>",
 *   task: "audio" | "burn",
 *   videoUrl: "https://cdn…/video.mp4",
 *   prefix: "sf/<feed id>/<item id>",            // R2 key prefix
 *   callbackUrl: "https://vidoleads.com/api/webhooks/renderer",
 *   audio?: { bitrate: "48k" },
 *   burn?: {
 *     style: { fontFamily, fontPx, marginPx, position: "bottom"|"top", color: "FFFFFF",
 *              background: "000000", backgroundOpacity: 0.6, maxLineChars },
 *     outputs: [{ lang: "fr", srtUrl: "https://…/fr.srt", name: "r2.fr" }],
 *   }
 * }
 *
 * Secrets come from the workflow environment, never from the job.
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const job = JSON.parse(process.env.JOB_JSON || "{}");
const WORK = "work";
const log = (...args) => console.log(new Date().toISOString(), ...args);

function run(cmd, args, { quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
      if (!quiet && err.length < 20000) process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${cmd} exited with ${code}: ${err.slice(-1500)}`));
    });
  });
}

async function download(url, file) {
  log("download", url);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}) for ${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
  const { size } = await stat(file);
  log("downloaded", file, `${(size / 1024 / 1024).toFixed(1)} MB`);
  return size;
}

async function probe(file) {
  const { out } = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], { quiet: true });
  const data = JSON.parse(out);
  const video = (data.streams || []).find((stream) => stream.codec_type === "video") || {};
  const audio = (data.streams || []).find((stream) => stream.codec_type === "audio") || null;
  return {
    width: Number(video.width) || 0,
    height: Number(video.height) || 0,
    duration: Number(data.format?.duration) || 0,
    audioCodec: audio?.codec_name || null,
  };
}

async function uploadToR2(file, key, contentType) {
  if (process.env.DRY_RUN) {
    const { size } = await stat(file);
    log("dry run — not uploading", key, `${(size / 1024 / 1024).toFixed(1)} MB`);
    return { url: `dry-run://${key}`, bytes: size };
  }
  // Cloudflare R2 by default; any S3-compatible store (Backblaze B2, …)
  // through S3_ENDPOINT.
  const endpoint = process.env.S3_ENDPOINT || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const bucket = process.env.R2_BUCKET;
  await run("aws", ["s3", "cp", file, `s3://${bucket}/${key}`, "--endpoint-url", endpoint, "--content-type", contentType, "--no-progress"], { quiet: true });
  const { size } = await stat(file);
  const base = String(process.env.R2_PUBLIC_BASE || "").replace(/\/+$/, "");
  log("uploaded", key, `${(size / 1024 / 1024).toFixed(1)} MB`);
  return { url: `${base}/${key}`, bytes: size };
}

async function callback(payload) {
  if (!job.callbackUrl) {
    log("no callbackUrl; result:", JSON.stringify(payload).slice(0, 2000));
    return;
  }
  const body = JSON.stringify({ jobId: job.id, task: job.task, ...payload });
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(job.callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.CALLBACK_SECRET || ""}` },
        body,
      });
      log("callback", response.status);
      if (response.ok) return;
    } catch (error) {
      log("callback failed", error.message);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
  }
}

/* ───────────── SRT → ASS ───────────── */

function parseSrt(srt) {
  const cues = [];
  for (const block of String(srt).replace(/\r/g, "").trim().split(/\n{2,}/)) {
    const lines = block.split("\n");
    const timeIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeIndex < 0) continue;
    const [start, end] = lines[timeIndex].split("-->").map((part) => part.trim());
    const text = lines.slice(timeIndex + 1).join("\n").trim();
    if (!text) continue;
    cues.push({ start: srtTime(start), end: srtTime(end), text });
  }
  return cues;
}

function srtTime(value) {
  const match = value.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4].padEnd(3, "0").slice(0, 3)) / 1000;
}

function assTime(seconds) {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const cs = Math.round((total - Math.floor(total)) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

/** "RRGGBB" + opacity (0..1 visible) → ASS "&HAABBGGRR" */
function assColor(hex, opacity = 1) {
  const clean = String(hex || "FFFFFF").replace(/^#/, "").padEnd(6, "0").slice(0, 6);
  const rr = clean.slice(0, 2);
  const gg = clean.slice(2, 4);
  const bb = clean.slice(4, 6);
  const alpha = Math.round((1 - Math.min(1, Math.max(0, opacity))) * 255);
  return `&H${alpha.toString(16).padStart(2, "0").toUpperCase()}${bb}${gg}${rr}`.toUpperCase();
}

const FONT_MAP = {
  Arial: "Liberation Sans",
  Helvetica: "Liberation Sans",
  Verdana: "DejaVu Sans",
  Roboto: "Roboto",
  "Open Sans": "Open Sans",
  Montserrat: "Montserrat",
};

function escapeAss(text) {
  return String(text).replace(/\\/g, "\\\\").replace(/\{/g, "(").replace(/\}/g, ")").replace(/\r?\n/g, "\\N");
}

/**
 * The ASS script: the style carries everything the caption look decides —
 * font, size (in video pixels), colours, box, position (bottom/top) and the
 * distance from that edge.
 */
function buildAss({ cues, width, height, style }) {
  const font = FONT_MAP[style.fontFamily] || style.fontFamily || "Liberation Sans";
  const fontPx = Math.max(12, Math.round(Number(style.fontPx) || Math.round(height * 0.045)));
  const marginV = Math.max(0, Math.round(Number(style.marginPx) || Math.round(height * 0.08)));
  const marginH = Math.round(width * 0.06);
  const boxOpacity = Number(style.backgroundOpacity) || 0;
  const alignment = style.position === "top" ? 8 : 2; // ASS numpad: 2 = bottom centre, 8 = top centre
  const primary = assColor(style.color || "FFFFFF", 1);
  const outline = boxOpacity > 0 ? assColor(style.background || "000000", boxOpacity) : assColor("000000", 1);
  const back = boxOpacity > 0 ? assColor(style.background || "000000", boxOpacity) : assColor("000000", 0.6);
  // BorderStyle 4 draws an opaque box behind each line (libass); 1 = outline + shadow.
  const borderStyle = boxOpacity > 0 ? 4 : 1;
  const outlineWidth = boxOpacity > 0 ? Math.max(4, Math.round(fontPx * 0.22)) : Math.max(2, Math.round(fontPx * 0.06));
  const shadow = boxOpacity > 0 ? 0 : Math.max(1, Math.round(fontPx * 0.04));
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${font},${fontPx},${primary},${primary},${outline},${back},0,0,0,0,100,100,0,0,${borderStyle},${outlineWidth},${shadow},${alignment},${marginH},${marginH},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const events = cues.map((cue) => `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Default,,0,0,0,,${escapeAss(cue.text)}`).join("\n");
  return `${header}${events}\n`;
}

function toVtt(cues, position) {
  const settings = position === "top" ? " line:8% align:center" : " align:center";
  const time = (seconds) => {
    const total = Math.max(0, seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = Math.floor(total % 60);
    const ms = Math.round((total - Math.floor(total)) * 1000);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
  };
  return `WEBVTT\n\n${cues.map((cue, index) => `${index + 1}\n${time(cue.start)} --> ${time(cue.end)}${settings}\n${cue.text}`).join("\n\n")}\n`;
}

/* ───────────── tasks ───────────── */

async function taskAudio(input) {
  const bitrate = job.audio?.bitrate || "48k";
  const out = `${WORK}/audio.mp3`;
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", input, "-vn", "-ac", "1", "-ar", "22050", "-b:a", bitrate, out]);
  const info = await probe(input);
  const uploaded = await uploadToR2(out, `${job.prefix}/audio.mp3`, "audio/mpeg");
  return { ok: true, audioUrl: uploaded.url, audioBytes: uploaded.bytes, width: info.width, height: info.height, duration: info.duration };
}

async function taskBurn(input) {
  const info = await probe(input);
  const style = job.burn?.style || {};
  const outputs = {};
  for (const output of job.burn?.outputs || []) {
    const response = await fetch(output.srtUrl, { redirect: "follow" });
    if (!response.ok) throw new Error(`Subtitle download failed (${response.status}) for ${output.lang}`);
    const cues = parseSrt(await response.text());
    if (cues.length === 0) throw new Error(`No cues in the ${output.lang} subtitle file`);
    const assFile = `${WORK}/${output.lang}.ass`;
    await writeFile(assFile, buildAss({ cues, width: info.width, height: info.height, style }), "utf8");
    const vttFile = `${WORK}/${output.lang}.vtt`;
    await writeFile(vttFile, toVtt(cues, style.position), "utf8");
    const outFile = `${WORK}/${output.lang}.mp4`;
    log("burn", output.lang, `${cues.length} cues`, `${info.width}x${info.height}`);
    const audioArgs = info.audioCodec === "aac" ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "160k"];
    await run("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error", "-stats",
      "-i", input,
      "-vf", `ass=${assFile}:fontsdir=fonts`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      ...audioArgs,
      outFile,
    ]);
    const name = output.name || output.lang;
    const video = await uploadToR2(outFile, `${job.prefix}/${name}.mp4`, "video/mp4");
    const vtt = await uploadToR2(vttFile, `${job.prefix}/${name}.vtt`, "text/vtt");
    outputs[output.lang] = { videoUrl: video.url, bytes: video.bytes, vttUrl: vtt.url, cues: cues.length };
  }
  return { ok: true, outputs, width: info.width, height: info.height, duration: info.duration };
}

async function main() {
  if (!job.id || !job.task || !job.videoUrl || !job.prefix) throw new Error("Job is missing id, task, videoUrl or prefix");
  if (!process.env.DRY_RUN) {
    const required = ["R2_BUCKET", "R2_PUBLIC_BASE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", ...(process.env.S3_ENDPOINT ? [] : ["R2_ACCOUNT_ID"])];
    for (const name of required) {
      if (!process.env[name]) {
        throw new Error(`Repository secret ${name.replace("AWS_ACCESS_KEY_ID", "R2_ACCESS_KEY_ID").replace("AWS_SECRET_ACCESS_KEY", "R2_SECRET_ACCESS_KEY")} is not set`);
      }
    }
  }
  await mkdir(WORK, { recursive: true });
  const input = `${WORK}/input.mp4`;
  await download(job.videoUrl, input);
  const result = job.task === "audio" ? await taskAudio(input) : job.task === "burn" ? await taskBurn(input) : null;
  if (!result) throw new Error(`Unknown task ${job.task}`);
  await callback(result);
  log("done", job.id);
}

main().catch(async (error) => {
  console.error(error);
  await callback({ ok: false, error: String(error?.message || error).slice(0, 1500) });
  process.exit(1);
});
