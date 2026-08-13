"""Can you actually sing over this?

The one thing this product does is let someone sing a song's words over a
newly generated backing track. That works only if the backing lands on the
same grid as the words. Every other quality, timbre, style, mix, is worth
nothing if it does not.

This exists because that was never checked. Components were verified in
isolation, all of them passing, while the assembled thing was unsingable: the
generated tracks sat a fifth to a half beat off the source, with rhythmic
correlation near zero, and lyrics timed to the original recording were being
displayed over them.

Run it against a render:

    py -3.11 tools/singability.py --source SONG.mp3 --render OUT.wav

Or render fresh and test in one go:

    py -3.11 tools/singability.py --source SONG.mp3 --style neon --seconds 60

Exits non-zero when a render is not singable, so it can gate a change.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import librosa  # noqa: E402
import numpy as np  # noqa: E402

SR = 22050


# Thresholds. These are not arbitrary: a beat at 136 bpm is 441 ms, and a
# listener notices a backing track pulling against them at roughly a tenth of
# that. 50 ms is comfortably inside "locked", 100 ms is audibly loose, and a
# fifth of a beat is a different groove.
BEAT_DISTANCE_MS = 50.0
TEMPO_ERROR_PERCENT = 2.0
# How much worse a render may be than the original recording at catching lyric
# starts. Zero would demand it beat the record it is imitating.
LYRIC_LANDING_TOLERANCE_MS = 30.0
HARMONIC_LIFT = 0.15
DURATION_ERROR_PERCENT = 2.0


@dataclass
class Check:
    name: str
    value: float
    limit: float
    unit: str
    higher_is_better: bool = False
    detail: str = ""

    @property
    def passed(self) -> bool:
        return self.value >= self.limit if self.higher_is_better else self.value <= self.limit

    def render(self) -> str:
        mark = "PASS" if self.passed else "FAIL"
        comparator = ">=" if self.higher_is_better else "<="
        return (
            f"  [{mark}] {self.name:34} {self.value:8.2f} {self.unit:4} "
            f"({comparator} {self.limit:.2f}) {self.detail}"
        )


def _beats(audio: np.ndarray) -> tuple[float, np.ndarray]:
    tempo, frames = librosa.beat.beat_track(y=audio, sr=SR, tightness=100)
    return float(np.atleast_1d(tempo)[0]), librosa.frames_to_time(frames, sr=SR)


def _nearest_distances(reference: np.ndarray, candidates: np.ndarray) -> np.ndarray:
    """For each reference time, distance to the nearest candidate time."""
    if candidates.size == 0 or reference.size == 0:
        return np.array([np.inf])
    index = np.searchsorted(candidates, reference)
    index = np.clip(index, 1, len(candidates) - 1)
    left = candidates[index - 1]
    right = candidates[index]
    return np.minimum(np.abs(reference - left), np.abs(reference - right))


def _onset_lag(source: np.ndarray, generated: np.ndarray) -> tuple[float, float]:
    """Best alignment lag between two onset envelopes, in milliseconds.

    Uses no beat tracking, so it is independent of the code that placed the
    beats. Searched only within a couple of seconds, because a peak found half
    a song away is a coincidence, not an alignment.
    """
    hop = 512
    o_src = librosa.onset.onset_strength(y=source, sr=SR, hop_length=hop)
    o_gen = librosa.onset.onset_strength(y=generated, sr=SR, hop_length=hop)
    m = min(len(o_src), len(o_gen))
    if m < 32:
        return 0.0, 0.0

    a = o_src[:m] - o_src[:m].mean()
    b = o_gen[:m] - o_gen[:m].mean()
    corr = np.correlate(a, b, mode="full") / (
        np.sqrt((a**2).sum() * (b**2).sum()) + 1e-9
    )

    centre = m - 1
    window = int(round(2.0 * SR / hop))
    low = max(0, centre - window)
    high = min(len(corr), centre + window + 1)
    local = corr[low:high]
    peak = int(np.argmax(local))
    lag_frames = (low + peak) - centre
    return lag_frames * hop / SR * 1000, float(local[peak])


def _chroma_lift(source: np.ndarray, generated: np.ndarray) -> float:
    """Harmonic agreement above a time-shuffled control."""
    n = min(len(source), len(generated))
    hop = 2048
    cs = librosa.feature.chroma_cqt(y=source[:n], sr=SR, hop_length=hop)
    cg = librosa.feature.chroma_cqt(y=generated[:n], sr=SR, hop_length=hop)
    frames = min(cs.shape[1], cg.shape[1])
    cs, cg = cs[:, :frames], cg[:, :frames]

    def score(a: np.ndarray, b: np.ndarray) -> float:
        values = [
            np.corrcoef(a[:, i], b[:, i])[0, 1]
            for i in range(frames)
            if a[:, i].std() > 1e-6 and b[:, i].std() > 1e-6
        ]
        return float(np.mean(values)) if values else 0.0

    rng = np.random.default_rng(0)
    aligned = score(cs, cg)
    shuffled = score(cs[:, rng.permutation(frames)], cg)
    return aligned - shuffled


def fetch_lyric_times(title: str, artist: str, duration: float) -> np.ndarray:
    """Lyric line start times from LRCLIB, or an empty array."""
    try:
        query = urllib.parse.urlencode({"track_name": title, "artist_name": artist})
        request = urllib.request.Request(
            f"https://lrclib.net/api/search?{query}",
            headers={"User-Agent": "Backline/1.0 singability-check"},
        )
        with urllib.request.urlopen(request, timeout=20) as response:
            hits = json.load(response)
    except Exception:
        return np.array([])

    best = None
    best_gap = np.inf
    for hit in hits:
        if not hit.get("syncedLyrics"):
            continue
        gap = abs((hit.get("duration") or 0) - duration)
        if gap < best_gap:
            best_gap = gap
            best = hit
    if best is None or best_gap > 8:
        return np.array([])

    times = []
    for line in best["syncedLyrics"].splitlines():
        if not line.startswith("["):
            continue
        stamp = line[1 : line.find("]")]
        if ":" not in stamp:
            continue
        try:
            minutes, seconds = stamp.split(":")
            times.append(float(minutes) * 60 + float(seconds))
        except ValueError:
            continue
    return np.array(sorted(times))


def evaluate(
    source_path: Path,
    render_path: Path,
    lyric_times: np.ndarray | None = None,
) -> list[Check]:
    source, _ = librosa.load(str(source_path), sr=SR, mono=True)
    generated, _ = librosa.load(str(render_path), sr=SR, mono=True)

    span = len(generated) / SR
    source_span = source[: len(generated)]

    src_tempo, src_beats = _beats(source_span)
    gen_tempo, gen_beats = _beats(generated)

    checks: list[Check] = []

    checks.append(
        Check(
            "tempo error",
            abs(gen_tempo - src_tempo) / max(src_tempo, 1e-6) * 100,
            TEMPO_ERROR_PERCENT,
            "%",
            detail=f"source {src_tempo:.1f}, render {gen_tempo:.1f} bpm",
        )
    )

    # Onset lag is reported, not graded.
    #
    # It was briefly a pass/fail check on the theory that it would catch a bar
    # phase error independently of beat tracking. It cannot. The arrangement
    # puts an onset on every beat, so the cross-correlation peaks at every beat
    # too, and lag 0, one beat and two beats score within noise of each other:
    # forcing all four bar phases produced an identical -882 ms reading. It is
    # kept as a diagnostic because a lag that is *not* a whole multiple of the
    # beat does mean something, but as a gate it only produced false alarms.
    lag_ms, lag_corr = _onset_lag(source_span, generated)
    beat_ms = 60_000 / max(src_tempo, 1e-6)
    print(
        f"  [note] onset lag {lag_ms:+.0f} ms (corr {lag_corr:+.2f}), "
        f"{lag_ms / beat_ms:+.2f} beats. Whole multiples of a beat are "
        f"expected here and are not evidence of a phase error."
    )

    usable = src_beats[src_beats < span]
    beat_distance = float(np.median(_nearest_distances(usable, gen_beats))) * 1000
    beat_period_ms = 60_000 / max(src_tempo, 1e-6)
    checks.append(
        Check(
            "beat grid distance (median)",
            beat_distance,
            BEAT_DISTANCE_MS,
            "ms",
            detail=f"{beat_distance / beat_period_ms * 100:.0f}% of a beat",
        )
    )

    checks.append(
        Check(
            "duration error",
            abs(span - len(source) / SR) / max(len(source) / SR, 1e-6) * 100,
            100.0,  # informational unless a full render was asked for
            "%",
            detail=f"{span:.1f}s of {len(source)/SR:.1f}s",
        )
    )

    checks.append(
        Check(
            "harmonic lift over shuffled",
            _chroma_lift(source_span, generated),
            HARMONIC_LIFT,
            "",
            higher_is_better=True,
            detail="does it follow the chords, not just the key",
        )
    )

    if lyric_times is not None and lyric_times.size > 0:
        inside = lyric_times[lyric_times < span]
        if inside.size:
            # Measured against the original recording rather than against an
            # absolute threshold. Lyric timestamps are hand-entered and singers
            # do not enter exactly on the beat: on this material LRCLIB's marks
            # sit a median 100 ms from the source's own beats. An absolute
            # limit was therefore grading the lyrics file, not the render. The
            # real question is whether words land as well over our track as
            # they do over the record they were timed to.
            baseline = float(np.median(_nearest_distances(inside, src_beats))) * 1000
            landing = float(np.median(_nearest_distances(inside, gen_beats))) * 1000
            checks.append(
                Check(
                    "lyric landing vs the original",
                    landing - baseline,
                    LYRIC_LANDING_TOLERANCE_MS,
                    "ms",
                    detail=(
                        f"{landing:.0f} ms on this render, {baseline:.0f} ms on the "
                        f"original, {inside.size} lines"
                    ),
                )
            )

    return checks


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--render", type=Path, help="an existing rendered wav")
    parser.add_argument("--style", default="neon")
    parser.add_argument("--engine", default=None, help="arranger | musicgen")
    parser.add_argument("--seconds", type=float, default=60.0)
    parser.add_argument("--title", default=None)
    parser.add_argument("--artist", default=None)
    parser.add_argument("--no-lyrics", action="store_true")
    args = parser.parse_args()

    render_path = args.render

    if render_path is None:
        from app import config
        from app.audio_utils import write_wav
        from app.models import melody

        if args.engine:
            config.ENGINE = args.engine
        print(f"rendering {args.seconds:.0f}s, style {args.style}, engine {config.ENGINE}...")
        audio, sr = melody.render_track(
            source_path=args.source,
            style_id=args.style,
            song_id="singability",
            max_seconds=args.seconds,
        )
        render_path = Path(__file__).resolve().parent / "singability-render.wav"
        write_wav(audio, sr, render_path)

    lyric_times = None
    if not args.no_lyrics:
        duration = librosa.get_duration(path=str(args.source))
        title = args.title or args.source.stem
        artist = args.artist or ""
        lyric_times = fetch_lyric_times(title, artist, duration)
        if lyric_times.size == 0:
            print("(no synced lyrics found, skipping the lyric landing check)")

    print(f"\nsource: {args.source.name}")
    print(f"render: {render_path.name}\n")

    checks = evaluate(args.source, render_path, lyric_times)
    for check in checks:
        print(check.render())

    failed = [c for c in checks if not c.passed]
    print()
    if failed:
        print(f"NOT SINGABLE: {len(failed)} of {len(checks)} checks failed")
        return 1

    print(f"SINGABLE: all {len(checks)} checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
