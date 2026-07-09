"""Generative MIDI core for the drwncvnt platform.

A small, dependency-light engine that turns a set of musical parameters into a
list of notes, then serialises that same note list two ways:

* ``notes_to_midi``  -> a proper ``mido.MidiFile`` (for download)
* ``notes_to_json``  -> a plain dict (for the in-browser Web Audio preview)

Because both serialisers consume the *same* note list produced from the *same*
seed, the audible preview and the downloaded ``.mid`` are guaranteed identical.

Four generation engines are provided: ``random_walk``, ``euclidean``,
``arpeggio`` and ``chaos`` (the original standalone algorithm, preserved).
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field

import mido

# ---------------------------------------------------------------------------
# Musical data
# ---------------------------------------------------------------------------

# Semitone offsets from the root for each supported scale / mode.
SCALES: dict[str, list[int]] = {
    "major": [0, 2, 4, 5, 7, 9, 11],
    "natural_minor": [0, 2, 3, 5, 7, 8, 10],
    "harmonic_minor": [0, 2, 3, 5, 7, 8, 11],
    "melodic_minor": [0, 2, 3, 5, 7, 9, 11],
    "dorian": [0, 2, 3, 5, 7, 9, 10],
    "phrygian": [0, 1, 3, 5, 7, 8, 10],
    "lydian": [0, 2, 4, 6, 7, 9, 11],
    "mixolydian": [0, 2, 4, 5, 7, 9, 10],
    "locrian": [0, 1, 3, 5, 6, 8, 10],
    "major_pentatonic": [0, 2, 4, 7, 9],
    "minor_pentatonic": [0, 3, 5, 7, 10],
    "blues": [0, 3, 5, 6, 7, 10],
    "whole_tone": [0, 2, 4, 6, 8, 10],
    "chromatic": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
}

# Note name -> semitone within an octave.
NOTE_NAMES: dict[str, int] = {
    "C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5,
    "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11,
}

# Diatonic scale-degree roots (0-indexed) used to spell chords for the
# arpeggiator, keyed loosely by tonality flavour. Values are indices into the
# scale's degree list; the chord is built by stacking thirds within the scale.
PROGRESSIONS: dict[str, list[int]] = {
    "minor": [0, 5, 2, 6],   # i - VI - III - VII
    "major": [0, 4, 5, 3],   # I - V - vi - IV
}

ENGINES = ("random_walk", "euclidean", "arpeggio", "chaos")
ARP_PATTERNS = ("up", "down", "updown", "random")
SUBDIVISIONS = {"8": 2, "16": 4, "triplet": 3}  # steps per beat

TICKS_PER_BEAT = 480


# ---------------------------------------------------------------------------
# Note model + parameters
# ---------------------------------------------------------------------------

@dataclass
class Note:
    start: int      # absolute tick
    dur: int        # length in ticks
    pitch: int      # MIDI note number 0-127
    velocity: int   # 1-127


@dataclass
class Params:
    key: str = "C"
    scale: str = "natural_minor"
    engine: str = "random_walk"
    bpm: int = 120
    subdivision: str = "16"
    bars: int = 8
    swing: int = 0            # 0-100
    octave_low: int = 3
    octave_high: int = 5
    density: int = 80         # 0-100 chance a step sounds
    rest_prob: int = 10       # 0-100 extra chance of a rest
    velocity_min: int = 70
    velocity_max: int = 120
    humanize: int = 20        # 0-100 timing/velocity jitter
    chords: bool = False
    arp_pattern: str = "updown"
    seed: int = 0             # 0 or absent -> random


@dataclass
class Meta:
    bpm: int
    seed: int
    ppq: int = TICKS_PER_BEAT
    engine: str = ""
    extra: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _root_midi(key: str, octave: int) -> int:
    """MIDI number of ``key`` in the given octave (C4 = 60)."""
    return (octave + 1) * 12 + NOTE_NAMES.get(key, 0)


def _scale_pitches(params: Params) -> list[int]:
    """All in-scale MIDI pitches spanning the requested octave range."""
    intervals = SCALES.get(params.scale, SCALES["natural_minor"])
    lo, hi = sorted((params.octave_low, params.octave_high))
    pitches: list[int] = []
    for octave in range(lo, hi + 1):
        base = _root_midi(params.key, octave)
        for iv in intervals:
            p = base + iv
            if 0 <= p <= 127:
                pitches.append(p)
    return sorted(set(pitches)) or [_root_midi(params.key, 4)]


def _euclidean(hits: int, steps: int) -> list[bool]:
    """Bjorklund algorithm: spread ``hits`` as evenly as possible over ``steps``."""
    hits = max(0, min(hits, steps))
    if steps <= 0:
        return []
    if hits == 0:
        return [False] * steps
    pattern: list[bool] = []
    bucket = 0
    for _ in range(steps):
        bucket += hits
        if bucket >= steps:
            bucket -= steps
            pattern.append(True)
        else:
            pattern.append(False)
    return pattern


def _step_ticks(params: Params) -> int:
    return TICKS_PER_BEAT // SUBDIVISIONS.get(params.subdivision, 4)


def _total_steps(params: Params) -> int:
    steps_per_beat = SUBDIVISIONS.get(params.subdivision, 4)
    return params.bars * 4 * steps_per_beat  # assume 4/4


def _chord_from_degree(scale_pitches: list[int], root_pitch: int, size: int = 3) -> list[int]:
    """Stack ``size`` scale tones as a chord starting at ``root_pitch``."""
    if root_pitch not in scale_pitches:
        # snap to nearest scale pitch
        root_pitch = min(scale_pitches, key=lambda p: abs(p - root_pitch))
    idx = scale_pitches.index(root_pitch)
    return [scale_pitches[idx + 2 * i] for i in range(size)
            if idx + 2 * i < len(scale_pitches)]


# ---------------------------------------------------------------------------
# Engines -- each returns a list[Note] on the grid, before shared post-steps
# ---------------------------------------------------------------------------

def engine_random_walk(params: Params, rng: random.Random) -> list[Note]:
    pitches = _scale_pitches(params)
    step = _step_ticks(params)
    notes: list[Note] = []
    idx = len(pitches) // 2
    for i in range(_total_steps(params)):
        # weighted step: mostly small moves, occasional leaps
        move = rng.choices([-2, -1, 0, 1, 2, -4, 4, -7, 7],
                           weights=[14, 22, 10, 22, 14, 6, 6, 3, 3])[0]
        idx = max(0, min(len(pitches) - 1, idx + move))
        vel = rng.randint(params.velocity_min, params.velocity_max)
        notes.append(Note(start=i * step, dur=step, pitch=pitches[idx], velocity=vel))
    return notes


def engine_euclidean(params: Params, rng: random.Random) -> list[Note]:
    pitches = _scale_pitches(params)
    step = _step_ticks(params)
    steps_per_bar = SUBDIVISIONS.get(params.subdivision, 4) * 4
    # hit count scales with density
    hits = max(1, round(steps_per_bar * params.density / 100))
    pattern = _euclidean(hits, steps_per_bar)
    notes: list[Note] = []
    idx = len(pitches) // 2
    for i in range(_total_steps(params)):
        if not pattern[i % steps_per_bar]:
            continue
        move = rng.choices([-2, -1, 1, 2, -4, 4], weights=[24, 26, 26, 14, 5, 5])[0]
        idx = max(0, min(len(pitches) - 1, idx + move))
        vel = rng.randint(params.velocity_min, params.velocity_max)
        notes.append(Note(start=i * step, dur=step, pitch=pitches[idx], velocity=vel))
    return notes


def engine_arpeggio(params: Params, rng: random.Random) -> list[Note]:
    pitches = _scale_pitches(params)
    step = _step_ticks(params)
    flavour = "major" if "major" in params.scale or params.scale == "lydian" \
        or params.scale == "mixolydian" else "minor"
    degrees = PROGRESSIONS[flavour]
    scale_intervals = SCALES.get(params.scale, SCALES["natural_minor"])
    base = _root_midi(params.key, (params.octave_low + params.octave_high) // 2)

    total = _total_steps(params)
    steps_per_bar = SUBDIVISIONS.get(params.subdivision, 4) * 4
    notes: list[Note] = []
    for i in range(total):
        bar = i // steps_per_bar
        degree = degrees[bar % len(degrees)]
        root = base + scale_intervals[degree % len(scale_intervals)]
        chord = _chord_from_degree(pitches, root, size=4)
        if not chord:
            continue
        order = _arp_order(chord, params.arp_pattern, rng)
        pitch = order[i % len(order)]
        vel = rng.randint(params.velocity_min, params.velocity_max)
        notes.append(Note(start=i * step, dur=step, pitch=pitch, velocity=vel))
    return notes


def _arp_order(chord: list[int], pattern: str, rng: random.Random) -> list[int]:
    if pattern == "up":
        return chord
    if pattern == "down":
        return list(reversed(chord))
    if pattern == "updown":
        return chord + list(reversed(chord[1:-1])) if len(chord) > 2 else chord
    # random
    return [rng.choice(chord) for _ in chord]


def engine_chaos(params: Params, rng: random.Random) -> list[Note]:
    """The original standalone algorithm, generalised over the chosen key/scale."""
    intervals = SCALES.get(params.scale, SCALES["natural_minor"])
    base = _root_midi(params.key, params.octave_low)
    scale = [base + iv for iv in intervals]
    step = _step_ticks(params)
    notes: list[Note] = []
    t = 0
    for _ in range(_total_steps(params)):
        note = rng.choice(scale) + rng.choice([-12, 0, 12, 24])
        note = max(0, min(127, note))
        # micro-delays a la the original (kept, but expressed on the grid)
        gap = rng.choice([0, 0, 1, 2]) * step
        dur = rng.choice([1, 1, 2]) * step
        vel = rng.randint(params.velocity_min, params.velocity_max)
        t += gap
        notes.append(Note(start=t, dur=dur, pitch=note, velocity=vel))
        t += dur
    return notes


ENGINE_FUNCS = {
    "random_walk": engine_random_walk,
    "euclidean": engine_euclidean,
    "arpeggio": engine_arpeggio,
    "chaos": engine_chaos,
}


# ---------------------------------------------------------------------------
# Shared post-processing
# ---------------------------------------------------------------------------

def _apply_shared(notes: list[Note], params: Params, rng: random.Random) -> list[Note]:
    step = _step_ticks(params)
    swing_ticks = int(step * 0.33 * params.swing / 100)
    hum = params.humanize / 100.0
    scale_pitches = _scale_pitches(params)
    out: list[Note] = []
    for n in notes:
        # density / rest gates (chaos manages its own gaps, skip its gating)
        if params.engine != "chaos":
            if rng.random() * 100 > params.density:
                continue
            if rng.random() * 100 < params.rest_prob:
                continue

        start = n.start
        # swing: push odd grid positions later
        if swing_ticks and params.engine != "chaos":
            if (start // step) % 2 == 1:
                start += swing_ticks

        # humanize timing + velocity
        if hum:
            jitter = int(step * 0.25 * hum)
            if jitter:
                start = max(0, start + rng.randint(-jitter, jitter))
            vspread = int(20 * hum)
            velocity = max(1, min(127, n.velocity + rng.randint(-vspread, vspread)))
        else:
            velocity = n.velocity

        out.append(Note(start=start, dur=max(1, n.dur), pitch=n.pitch, velocity=velocity))

        # chords: stack a triad above melody notes (non-arp engines)
        if params.chords and params.engine not in ("arpeggio",):
            for extra in _chord_from_degree(scale_pitches, n.pitch, size=3)[1:]:
                out.append(Note(start=start, dur=max(1, n.dur),
                                pitch=extra, velocity=max(1, velocity - 12)))

    out.sort(key=lambda x: (x.start, x.pitch))
    return out


# ---------------------------------------------------------------------------
# Public entry point + serialisers
# ---------------------------------------------------------------------------

def build(params: Params) -> tuple[list[Note], Meta]:
    """Validate seed, run the chosen engine, apply shared steps. Deterministic."""
    seed = params.seed if params.seed else random.randint(1, 2_000_000_000)
    rng = random.Random(seed)

    engine = params.engine if params.engine in ENGINE_FUNCS else "random_walk"
    notes = ENGINE_FUNCS[engine](params, rng)
    notes = _apply_shared(notes, params, rng)

    meta = Meta(bpm=params.bpm, seed=seed, engine=engine,
                extra={"scale": params.scale, "key": params.key,
                       "bars": params.bars, "notes": len(notes)})
    return notes, meta


def notes_to_midi(notes: list[Note], meta: Meta) -> mido.MidiFile:
    """Serialise notes to a valid single-track MIDI file with correct deltas."""
    mid = mido.MidiFile(ticks_per_beat=meta.ppq)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    track.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(meta.bpm), time=0))
    track.append(mido.MetaMessage("track_name", name=f"drwncvnt {meta.engine}", time=0))

    # Build absolute-time event list, then convert to delta time.
    events: list[tuple[int, int, str, int, int]] = []
    for order, n in enumerate(notes):
        events.append((n.start, 0, "note_on", n.pitch, n.velocity))
        events.append((n.start + n.dur, 1, "note_off", n.pitch, 0))
    # sort by time; note_off (kind 1) before note_on at the same tick avoids
    # clipping a re-struck pitch.
    events.sort(key=lambda e: (e[0], e[1], e[3]))

    prev = 0
    for abs_time, _kind, kind_name, pitch, vel in events:
        delta = abs_time - prev
        prev = abs_time
        track.append(mido.Message(kind_name, note=pitch, velocity=vel, time=delta))

    track.append(mido.MetaMessage("end_of_track", time=1))
    return mid


def notes_to_json(notes: list[Note], meta: Meta) -> dict:
    """Serialise for the browser: times/durations in seconds for Web Audio."""
    sec_per_tick = (60.0 / meta.bpm) / meta.ppq
    return {
        "bpm": meta.bpm,
        "seed": meta.seed,
        "engine": meta.engine,
        "ppq": meta.ppq,
        "meta": meta.extra,
        "notes": [
            {
                "p": n.pitch,
                "start": round(n.start * sec_per_tick, 5),
                "dur": round(n.dur * sec_per_tick, 5),
                "vel": n.velocity,
            }
            for n in notes
        ],
    }
