# Backline, AI Karaoke Studio

Build spec this repository was written against. Transcribed from the original
brief. Where the implementation departs from it, the reason is noted inline
under "Deviations" at the bottom.

Working name: Backline, a real music industry term for the stage crew, used as
the umbrella brand for the AI helper characters.

## 1. Concept

A web app where a user sings along to a song, and an AI generated backing track
adapts live to their voice (pitch, tempo) while showing synced lyrics and
reactive camera overlays. Songs come from a built in NCS (No Copyright Sounds)
library, or the user can import their own track and have it re-rendered into a
new instrumental style (synthwave, pop, rock, chill, jazz) using melody
conditioned AI music generation. Not a stem swap, an actual regenerated
instrumental that follows the original melody.

A branded cast of Backline characters, reskinned per style, act as the on screen
crew reacting to the performance.

## 2. Core user flow

1. User opens the app and browses the song library, or imports their own audio.
2. User picks a style: Neon (synthwave), Velvet (jazz), Riff (rock), Tide
   (pirate sea shanty), Grove (chill), Bloom (pop).
3. App checks the cache for that song and style combination. Cache hit loads
   instantly. Cache miss calls the Inference API, shows a short "tuning your
   stage" loading state, and stores the result for next time.
4. User grants camera and mic access. The performance screen loads with backing
   track, karaoke style synced lyrics, and camera feed with character overlay.
5. User sings. Client side pitch and tempo tracking of the mic input drives real
   time time-stretch and pitch-shift of the backing track so it stays locked to
   the user's key and speed. Characters react to pitch accuracy and energy.
6. End of song shows a simple recap, not a full scoring system.

## 3. Feature spec

### 3.1 Song library

Six to eight built in NCS tracks to start, stored with metadata: title, artist,
bpm, key, duration, lyrics with timestamps. NCS tracks are used per their free
use terms, for the built in library only.

### 3.2 Style based backing track generation

Six styles at launch. Generation is melody conditioned: extract the song's
melody and chords once, feed that to a melody conditioned model along with a
style text prompt, and get a new instrumental that follows the original melody
but sounds like the chosen genre. This is not vocal removal plus a generic loop.
Every song and style combination is generated once and cached.

### 3.3 Real time vocal adaptive playback

Runs entirely client side in the browser using the Web Audio API. No network
round trip during a live take. Live pitch detection (autocorrelation or YIN)
plus tempo tracking on the mic input. The backing track plays through a real
time time-stretch and pitch-shift layer, a phase vocoder, that nudges within a
bounded range (roughly 2 semitones and 15 percent tempo) to stay locked to the
singer.

### 3.4 Lyrics

Karaoke style synced captions. Built in tracks ship bundled lyrics and
timestamps as metadata. Imported tracks are auto transcribed and aligned with
Whisper.

### 3.5 Import and convert

User uploads an audio file. The Inference API extracts melody and tempo, runs
the same melody conditioned generation pipeline against the chosen style, and
transcribes lyrics with Whisper. The result is cached under a user generated
song id so replays are instant.

### 3.6 Camera and overlays

MediaPipe face and pose landmarks drive canvas or WebGL overlays. Overlays react
to live pitch accuracy and vocal energy through aura pulses and character
bounce. Tone is fun and readable for all ages, not flashy or strobing and not
bare bones either. Soft particle and glow effects, no rapid flashing, for
accessibility.

### 3.7 Backline branding

One rigged mascot crew, reskinned per style, which keeps art and animation work
light while giving each genre a distinct feel.

| Skin             | Style             | Vibe                 |
| ---------------- | ----------------- | -------------------- |
| Backline: Neon   | Synthwave         | Retro future robots  |
| Backline: Velvet | Jazz              | Speakeasy band       |
| Backline: Riff   | Rock              | Roadie gang          |
| Backline: Tide   | Pirate sea shanty | Deckhand crew        |
| Backline: Grove  | Chill lo-fi       | Forest spirits       |
| Backline: Bloom  | Pop               | Studio glam crew     |

## 4. System architecture

Two local servers, no shared process.

```
+-------------------------+        LAN         +--------------------------+
|  Inference API Server   | <----------------> |       App Server         |
|  (runs on RTX 4070 box) |  HTTP/JSON, async  |  (frontend + light API)  |
|  headless, no UI        |                    |  serves users            |
+-------------------------+                    +--------------------------+
```

The Inference API server is headless and GPU bound and owns the ML models. It is
never exposed to the internet in version one, LAN only. The App Server is the
product surface and owns the cache index, song metadata, lyrics, session state,
and camera and overlay logic. It calls the Inference API only on cache misses.

## 5. Inference API server

Hardware: RTX 4070, 12 GB VRAM, which comfortably fits MusicGen-melody at 1.5B
parameters, roughly 6 GB at fp16. Melody-large at 3.3B is viable with 8 bit
quantization to push quality later.

Models: MusicGen-melody from facebookresearch/audiocraft as the default for
melody conditioned generation, with MuseControlLite and HeartMuLa-oss-3B worth
prototyping as alternatives. librosa or CREPE for melody, tempo and key
extraction. Whisper for lyrics transcription and alignment, any open checkpoint
that fits VRAM alongside the music model, or run sequentially.

Endpoints, all JSON, no auth needed for a LAN only version one:

```
POST /analyze
  in:  { audio_url | audio_base64 }
  out: { bpm, key, melody_contour, duration }

POST /generate
  in:  { source: song_id | audio_base64, style }
  out: { job_id }

GET /status/{job_id}
  out: { status: "queued"|"running"|"done"|"error", result_url? }

POST /transcribe
  in:  { audio_url | audio_base64 }
  out: { lyrics: [{ text, start, end }, ...] }
```

Generation is async and pollable. Even a fast GPU render of seconds to a minute
should not block an HTTP request.

## 6. App server and frontend

Next.js for the frontend, a light Node or Python backend for cache index and
session logic, SQLite or a flat JSON index for the cache. No heavy database is
needed at this scale.

```
GeneratedTrack { id, song_id, style, audio_url, bpm, key, created_at }
Song           { id, title, artist, source, duration, lyrics[] }
```

Screens: library and import, style picker with skin preview, loading state for
cache misses, performance screen, post song recap.

## 7. Real time DSP layer, client side

Web Audio API plus AudioWorklet for low latency processing. YIN or
autocorrelation pitch detection on the mic input, per frame. Phase vocoder time
stretch and pitch shift applied to the backing track buffer, bounded to a small
correction range so it never sounds unnatural. This layer never talks to either
server during a live take. It only operates on the already fetched cached audio
buffer.

## 8. Version one scope cuts

Explicitly out of scope, do not build these in the one to two day window.

- No user accounts or auth. Local session state is fine.
- No public internet hosting. LAN only between the two servers.
- No scoring or leaderboard. The recap is a summary, not a graded score.
- No mobile app. Web only, responsive is a bonus.
- No multi user concurrency handling. Single user demo scale.
- Song catalog capped at six to eight tracks, style set capped at the six above.
- No live generation per note. Generation is always cache or generate once,
  never continuous during singing.

## 9. Suggested build order

Day one: scaffold both servers, get MusicGen-melody running and wired to
`/generate` and `/status` tested end to end on one song and one style, build the
cache index and wire cache miss handling, then a basic unstyled library and
style picker.

Day two: real time DSP layer, lyrics sync, camera overlay with MediaPipe and one
fully reactive skin with the rest stubbed, then a polish pass.

## 10. Environment and config

```
# Inference API server
MODEL_PATH=...
DEVICE=cuda
PORT=8001

# App server
INFERENCE_API_URL=http://<gpu-box-local-ip>:8001
CACHE_DIR=./cache
PORT=3000
```

Both machines must be on the same LAN. No internet exposure needed.

## 11. Open defaults

Web app not mobile. Cache first, generate on miss, never live per note. Melody
conditioned open source model self hosted on the user's own GPU, no paid third
party API. Six styles, six to eight starter songs, no auth, no scoring, LAN
only. One mascot rig with six reskins.

## Deviations from this spec

**VRAM.** The target machine turned out to be an RTX 4070 Laptop with 8 GB, not
the 12 GB desktop part assumed in section 5. MusicGen-melody at 1.5B still fits
with half precision language model weights, but it cannot share the card with
Whisper. The implementation adds a model registry that keeps exactly one model
resident, evicts on switch, and frees after an idle timeout. Melody-large is out
of reach on this hardware.

**Chunked generation.** Section 3.2 does not address the fact that MusicGen
generates at most 30 seconds per call. Full length tracks are rendered as
successive melody conditioned windows joined with equal power crossfades, with a
deterministic seed per song and style. Harmonic continuity across a seam is not
guaranteed.

**Stub mode.** Not in the spec. The inference server ships with a placeholder
synth renderer so the entire application runs before the multi gigabyte model
install, which makes the build order in section 9 practical to follow out of
order.

**Generation backend.** Section 5 names audiocraft. On Windows audiocraft pins
an `av` version with no CPython 3.11 wheel and pulls in xformers, so installing
it needs a full MSVC toolchain. The implementation uses the same
facebook/musicgen-melody weights through the transformers implementation, which
has the same chroma conditioning and installs as pure Python. Switching back
touches one file.

**Time-stretch algorithm.** Section 7 specifies a phase vocoder. The
implementation uses WSOLA feeding an interpolating resampler instead. Given
section 3.3 bounds corrections to about two semitones and fifteen percent,
WSOLA is cheaper in that range, does not smear transients, and needs no FFT on
the render thread. Measured accuracy is within a cent of target on both axes,
see the test bench at /dev/dsp.

**Cache index.** Section 6 offers SQLite or a flat JSON index. Both are used:
SQLite for generated tracks, because the miss path interleaves reads and writes
with a poll loop and a whole-file rewrite would race with itself, and JSON for
song metadata, which is written once per song by a background pass. The SQLite
binding is Node's built-in `node:sqlite` rather than better-sqlite3, so cloning
this repo does not require a C++ toolchain.
