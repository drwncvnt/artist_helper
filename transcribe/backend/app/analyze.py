"""Audio-to-MIDI transcription, run inside the worker processes.

The heavy lifting is Spotify's `basic-pitch` neural model. Loading and first-run
warm-up of that model costs ~15s, so each worker process loads it exactly once
(in ``worker_init``) and reuses it for every job it handles — after warm-up a
short clip transcribes in well under a second.

This module runs in the ProcessPoolExecutor workers, never in the web process.
"""

import logging
import os

import numpy as np
import pretty_midi

# Keep TensorFlow/basic-pitch quiet in the logs.
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
logging.getLogger("tensorflow").setLevel(logging.ERROR)

# One loaded model per worker process, populated by worker_init().
_MODEL = None

# The smallest note length we keep after quantizing, so a note never collapses
# to zero duration.
_MIN_NOTE_SECONDS = 0.03


def worker_init():
    """Load the model once per worker process and warm it up with a dummy clip.

    Warming up here means the first *real* user job is already fast, at the cost
    of a one-time delay while the pool starts."""
    global _MODEL
    from basic_pitch import ICASSP_2022_MODEL_PATH
    from basic_pitch.inference import Model, predict

    _MODEL = Model(ICASSP_2022_MODEL_PATH)

    # Warm-up inference on a half-second tone so TensorFlow builds its graph now.
    import soundfile as sf
    import tempfile

    sr = 22050
    t = np.linspace(0, 0.5, int(sr * 0.5), endpoint=False)
    tone = (0.2 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as fh:
        warm_path = fh.name
    try:
        sf.write(warm_path, tone, sr)
        predict(warm_path, model_or_model_path=_MODEL)
    finally:
        os.unlink(warm_path)


def warm_noop() -> bool:
    """Trivial task used at startup to force a worker process to spawn and run
    ``worker_init``. The brief sleep keeps two such tasks in flight at once so
    both workers (not just one, reused) get created and warmed."""
    import time

    time.sleep(3)
    return True


def _quantize(seconds: float, tempo: float) -> float:
    """Snap a time to the nearest 1/16th-note grid at the given tempo."""
    grid = (60.0 / tempo) / 4.0  # sixteenth-note length in seconds
    return round(seconds / grid) * grid


def transcribe(in_path: str, out_path: str, tempo: float, quantize: bool) -> int:
    """Transcribe an audio file to a MIDI file at ``out_path``.

    The output MIDI carries the caller's tempo; when ``quantize`` is set, note
    starts/ends are snapped to the tempo's 1/16th-note grid so the result lines
    up with a DAW. Returns the number of notes written.
    """
    from basic_pitch.inference import predict

    _, midi_data, _ = predict(in_path, model_or_model_path=_MODEL)

    # Rebuild the MIDI so it carries the requested tempo (and, optionally, a
    # quantized grid). basic-pitch always emits a default 120 BPM file.
    out = pretty_midi.PrettyMIDI(initial_tempo=float(tempo))
    note_count = 0
    for inst in midi_data.instruments:
        new_inst = pretty_midi.Instrument(program=inst.program, is_drum=inst.is_drum, name=inst.name)
        for n in inst.notes:
            start, end = n.start, n.end
            if quantize:
                start = _quantize(start, tempo)
                end = _quantize(end, tempo)
                if end - start < _MIN_NOTE_SECONDS:
                    end = start + _MIN_NOTE_SECONDS
            new_inst.notes.append(
                pretty_midi.Note(velocity=n.velocity, pitch=n.pitch, start=start, end=end)
            )
            note_count += 1
        out.instruments.append(new_inst)

    out.write(out_path)
    return note_count
