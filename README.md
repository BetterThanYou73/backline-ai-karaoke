# Backline

An AI karaoke studio. You sing, and the backing track follows you.

Pick a song and a style, and the app renders a brand new instrumental in that
genre using melody-conditioned music generation running on a local GPU. Not
stem separation, not a stock loop: the model is conditioned on the original
song's melody and produces a fresh arrangement that follows it. While you sing,
the browser tracks your pitch and tempo in real time and time-stretches and
pitch-shifts the backing track to stay locked to your voice, with synced lyrics
and a reactive camera overlay on screen.

Named after the backline, the stage crew that sets up and runs a band's gear.

## What is interesting here

**Melody-conditioned generation, not stem swapping.** MusicGen-melody takes the
extracted chroma of the source track plus a style prompt and generates a new
instrumental. Because the model caps out at 30 seconds per call, full songs are
rendered as successive melody-conditioned windows joined with equal-power
crossfades, seeded deterministically per song and style so a re-render
reproduces the same take.

That the output actually follows the source is checkable rather than assumed.
Correlating the chroma of a generated track against its source frame by frame
gives +0.53, while the same track against a time-reversed copy of that source
gives +0.29. The gap is the conditioning doing its job; without it both numbers
would sit together, since two pieces in the same key correlate somewhat no
matter what.

**Real-time DSP in the browser, zero network in the loop.** Pitch detection
(YIN) and time-scale modification (WSOLA plus interpolated resampling) both run
inside AudioWorklets on the audio render thread. Once the backing track is
fetched, a live take never touches either server. Corrections are bounded to
plus or minus 2 semitones and 15 percent tempo so the track never sounds warped.

**Two services, one GPU.** A headless FastAPI inference server owns every model
and serializes GPU work behind a single worker. A Next.js app server owns the
cache index, song metadata, and session state, and calls inference only on a
cache miss. The split means the GPU box can move to another machine on the LAN
by changing one environment variable.

**Built for 8 GB of VRAM.** MusicGen-melody at fp16 occupies 6803 MiB of the
8187 MiB on a laptop 4070, so Whisper cannot be resident at the same time. A
model registry keeps exactly one model loaded, evicts on switch, and frees
after an idle timeout. Measured on this machine: 6803 MiB with MusicGen
resident, 2006 MiB after a transcription evicts it.

Rendering 20 seconds of audio takes about 36 seconds on that card.

## Stack

Python, FastAPI, PyTorch, CUDA, MusicGen-melody (transformers), faster-whisper,
librosa, TypeScript, Next.js, React, Web Audio API, AudioWorklet, MediaPipe,
SQLite.

## Architecture

```
   browser                    App Server (:3000)              Inference API (:8001)
+-----------+              +--------------------+           +---------------------+
| mic + cam |              |  Next.js frontend  |           |  FastAPI, headless  |
|           |   HTTP       |  cache index       |   HTTP    |  MusicGen-melody    |
| AudioWork |<------------>|  song metadata     |<--------->|  faster-whisper     |
| YIN+WSOLA |  (fetch once)|  lyrics, sessions  | on a miss |  librosa analysis   |
+-----------+              +--------------------+           +---------------------+
                                     |                                |
                                  cache/                        one GPU, one
                              generated tracks                  resident model
```

A live take runs entirely in the left box. The right box is only reached when a
song and style combination has never been rendered before.

## Running it

Two processes. Both can live on the same machine, or the inference server can
sit on whichever box has the GPU.

### Inference server

```powershell
cd inference
.\setup.ps1        # base tier, runs in stub mode
.\run.ps1
```

It starts with `STUB_MODE=1`, which returns a synthesized placeholder
instrumental instead of loading a 6 GB model. Analysis (bpm, key, melody
contour) is real either way. The whole app works in this mode, which is how you
should develop against it.

For real generation:

```powershell
cd inference
.\setup.ps1 -Gpu
```

Then pull the weights before you need them, rather than during a demo:

```powershell
.venv\Scripts\python.exe download_models.py
```

MusicGen-melody is about 6 GB. Downloads resume, so an interrupted run costs
only the time already spent. Once it finishes, set `STUB_MODE=0` in
`inference/.env` and restart the server.

### App server

```powershell
cd app
npm install
npm run dev
```

Open http://localhost:3000. Needs Node 22.5 or newer for the built-in
`node:sqlite` module.

### Checking the audio path

```
http://localhost:3000/dev/dsp
```

Drives both worklets with synthetic signals of known pitch inside an
`OfflineAudioContext` and reports the measured result against the expected one.
It renders faster than real time and needs no microphone, no output device and
no permissions, so it runs anywhere the app builds.

This exists because the audio path is the part most likely to be quietly wrong
and the hardest to check by ear: a pitch shift three percent off still sounds
like music. It has caught three real bugs so far, one of them in itself.
Current state is ten of ten:

| Test                                | Expected             | Measured             |
| ----------------------------------- | -------------------- | -------------------- |
| YIN detects 220 Hz                  | 220 Hz               | 220.0 Hz, +0.1 cents |
| YIN detects 440 Hz                  | 440 Hz               | 440.2 Hz, +0.8 cents |
| Shift up 2 semitones                | 493.9 Hz             | 494.0 Hz, +0.4 cents |
| Shift down 2 semitones              | 392.0 Hz             | 391.9 Hz, -0.3 cents |
| Speed up 15 percent, pitch held     | 440 Hz               | 440.0 Hz, -0.1 cents |
| Speed up 15 percent, source consumed| 1.15x                | 1.129x               |
| Slow down 15 percent, pitch held    | 440 Hz               | 440.1 Hz, +0.4 cents |
| Slow down 15 percent, source consumed| 0.85x               | 0.834x               |
| Unity consumes source in real time  | 1.00x                | 0.981x               |
| Unity passthrough                   | 440 Hz               | 440.0 Hz, +0.1 cents |

The consumption rows exist because the pitch rows cannot test tempo. The test
signal is a stationary tone, and a stationary tone time-stretched by any factor
is the same tone, so an earlier version of this bench passed both tempo rows
while measuring nothing about tempo at all: a processor that ignored the
setting outright would have scored identically. Measuring how much source audio
was consumed per second of output is what actually pins the tempo axis down.

### Adding songs

Drop any mp3, wav, flac, or m4a into `app/data/songs/`. The library scans that
folder on boot, sends each new file to `/analyze` for bpm, key and duration, and
writes the results to `app/data/songs.json`. Lyrics come from a sidecar
`<filename>.lyrics.json` if present, otherwise Whisper transcribes on first
play.

NCS tracks are used under the No Copyright Sounds free-use terms, which require
attribution. Nothing copyrighted is committed to this repository.

## Inference API

| Method | Path              | Returns                                        |
| ------ | ----------------- | ---------------------------------------------- |
| POST   | `/analyze`        | `{bpm, key, melody_contour, duration}`         |
| POST   | `/generate`       | `{job_id}`, async                              |
| GET    | `/status/{id}`    | `{status, progress, result_url?}`              |
| POST   | `/transcribe`     | `{lyrics: [{text, start, end}]}`               |
| GET    | `/health`         | device, VRAM, resident model, stub mode        |

Generation is async because even a fast render takes tens of seconds. The app
server polls status and shows a loading state.

## Known limits

**MusicGen has no memory across windows.** It generates at most 30 seconds per
call, so a full song is rendered as successive windows, and nothing carries
between them. Each window follows the melody it was conditioned on, but the
arrangement can restart, and there is no verse, no chorus, no return of
anything. On a song with real structure this is what you hear: it holds up for
a window and then stops resembling the song's shape, however well each
individual window tracks its own melody. This is a property of the model, not
of the wiring around it, and it is not fixable at 1.5B parameters on 8 GB.

Stripping percussion from the conditioning audio with HPSS was tried, on the
reasoning that a full mix is mostly drums by energy and drums smear chroma
across every pitch class. Measured over four matched seeds it changed harmonic
agreement by -0.019 +/- 0.063, better on two seeds of four. Noise. Not shipped.

The stub arranger does follow song structure, because it works from the
extracted chord progression rather than generating, so ironically it stays
recognisably the same song for longer than the real model does.

Live tempo tracking from a monophonic vocal is coarse. It is smoothed heavily
and held at 1.0 when confidence is low, which is the honest behaviour rather
than chasing a noisy estimate.

Whisper on singing is less accurate than on speech, especially with sustained
vowels. Bundled lyric timings beat transcription whenever they exist.

## Scope

Version one is deliberately small: no accounts, no scoring or leaderboard, no
public hosting, no mobile app, single user. See `docs/SPEC.md` for the full
build spec this was written against.

## Licence

Code in this repository is MIT. Models, and any audio you add, carry their own
terms.
