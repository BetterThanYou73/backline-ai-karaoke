"""The six Backline styles and the text prompts that drive generation.

Kept server-side so the App Server only ever sends a style id. Prompt wording is
the main quality lever on MusicGen output, so this is the file to tune first if
a style sounds wrong.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Style:
    id: str
    label: str
    genre: str
    prompt: str
    # Nudges MusicGen toward/away from the text prompt. Higher tracks the prompt
    # harder but drifts from the conditioning melody.
    cfg_coef: float = 3.0


STYLES = {
    s.id: s
    for s in [
        Style(
            id="neon",
            label="Backline: Neon",
            genre="synthwave",
            prompt=(
                "80s synthwave instrumental, analog synth arpeggios, gated reverb "
                "drums, warm saturated bass, retro-futuristic night drive, wide stereo pads"
            ),
        ),
        Style(
            id="velvet",
            label="Backline: Velvet",
            genre="jazz",
            prompt=(
                "smooth jazz instrumental, brushed drums, walking upright bass, warm "
                "Rhodes piano comping, muted trumpet, intimate speakeasy club recording"
            ),
        ),
        Style(
            id="riff",
            label="Backline: Riff",
            genre="rock",
            prompt=(
                "energetic rock instrumental, crunchy distorted electric guitar riffs, "
                "driving live drums, punchy bass, tight garage band performance"
            ),
        ),
        Style(
            id="tide",
            label="Backline: Tide",
            genre="pirate/sea-shanty",
            prompt=(
                "sea shanty instrumental, accordion and fiddle lead, stomping wooden "
                "percussion, hand claps, rolling folk rhythm, tall ship at sea"
            ),
        ),
        Style(
            id="grove",
            label="Backline: Grove",
            genre="chill/lo-fi",
            prompt=(
                "lo-fi chill instrumental, dusty vinyl crackle, mellow Rhodes chords, "
                "soft boom bap drums, warm tape saturation, relaxed late night study beat"
            ),
        ),
        Style(
            id="bloom",
            label="Backline: Bloom",
            genre="pop",
            prompt=(
                "modern pop instrumental, bright plucked synths, four on the floor beat, "
                "glossy radio-ready production, uplifting chord progression, clean mix"
            ),
        ),
    ]
}

STYLE_IDS = tuple(STYLES.keys())
