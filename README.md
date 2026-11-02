# subtitle-renderer

Free rendering machine for VidoLeads **Subtitle feeds** (Studio → Subtitle feeds).

VidoLeads starts one workflow run per job through the GitHub API. The run
downloads the source video, extracts the audio track (for transcription) or
burns the translated subtitles into a new MP4 with FFmpeg, uploads the result
to Cloudflare R2 and reports back to VidoLeads. No video, subtitle text or
secret is stored in this repository.

## Repository secrets (Settings → Secrets and variables → Actions)

| Secret | What |
| --- | --- |
| `R2_ACCOUNT_ID` | Cloudflare account id (R2 → Overview, right side) |
| `R2_ACCESS_KEY_ID` | R2 API token → Access Key ID |
| `R2_SECRET_ACCESS_KEY` | R2 API token → Secret Access Key |
| `R2_BUCKET` | bucket name, e.g. `mb-subtitles` |
| `R2_PUBLIC_BASE` | the bucket's public URL, e.g. `https://pub-xxxx.r2.dev` (no trailing slash) |
| `CALLBACK_SECRET` | the same value as VidoLeads' `CRON_SECRET` |
| `S3_ENDPOINT` | optional — another S3-compatible store instead of R2, e.g. Backblaze B2 `https://s3.eu-central-003.backblazeb2.com` (then `R2_ACCOUNT_ID` is not needed and `R2_PUBLIC_BASE` is the bucket's public URL, e.g. `https://f003.backblazeb2.com/file/mb-subtitles`) |

## Files

- `.github/workflows/render.yml` — the workflow (`workflow_dispatch`, input `job`)
- `render.mjs` — the worker: download → ffmpeg → R2 → callback
