"""Audio analysis core: tempo, key, and loudness/level metrics.

Everything here is pure signal processing - no web framework code - so it can be
tested and reasoned about on its own. `librosa` (tempo + key) relies on `numba`,
which JIT-compiles its internal functions on first use; that first call costs a
real amount of time (tens of seconds), while every call after it is fast because
the compiled code is cached for the life of the process. `warm_up()` pays that
cost once, at server startup, so the first real user request isn't the slow one.
"""

import logging
import os

import librosa
import numpy as np
import pyloudnorm

# Quiet down noisy library logging; none of it is useful to end users.
logging.getLogger("numba").setLevel(logging.WARNING)

# Krumhansl-Schmuckler key profiles: the relative strength listeners perceive
# for each pitch class within a major/minor key. Correlating a track's chroma
# (energy per pitch class) against every rotation of these profiles is a
# standard, well-tested way to estimate musical key without training a model.
_MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def _detect_key(y: np.ndarray, sr: int) -> tuple[str, float]:
    """Returns (key name e.g. "C major", correlation confidence 0-1)."""
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
    best_name, best_corr = "C major", -1.0
    for i in range(12):
        major_corr = np.corrcoef(np.roll(_MAJOR_PROFILE, i), chroma)[0, 1]
        minor_corr = np.corrcoef(np.roll(_MINOR_PROFILE, i), chroma)[0, 1]
        if major_corr > best_corr:
            best_corr, best_name = major_corr, f"{_NOTE_NAMES[i]} major"
        if minor_corr > best_corr:
            best_corr, best_name = minor_corr, f"{_NOTE_NAMES[i]} minor"
    return best_name, max(0.0, min(1.0, float(best_corr)))


def analyze(path: str) -> dict:
    """Analyze an audio file and return its musical/level metrics.

    Loaded as mono for the DSP: tempo, key, and level metrics are all
    well-defined on a mono mixdown, and it keeps analysis time and memory
    small and predictable regardless of the source channel count.
    """
    y, sr = librosa.load(path, sr=None, mono=True)
    if y.size == 0:
        raise ValueError("Audio file has no samples.")

    # Harmonic-percussive source separation: sustained tonal content (chords,
    # bass, vocals) and transient content (kicks, snares, hats) get analyzed
    # separately below because each one only helps the metric it's suited
    # for and actively hurts the other - percussive transients smear pitch-
    # class energy and bias key detection, while sustained harmonic content
    # (long pads, held bass notes, reverb tails) blurs the onset envelope and
    # biases beat tracking. Splitting them first is standard MIR practice for
    # both tempo and key estimation.
    y_harmonic, y_percussive = librosa.effects.hpss(y)

    tempo, _beat_frames = librosa.beat.beat_track(y=y_percussive, sr=sr)
    bpm = float(np.atleast_1d(tempo)[0])

    key, key_confidence = _detect_key(y_harmonic, sr)

    meter = pyloudnorm.Meter(sr)
    lufs = float(meter.integrated_loudness(y))

    peak = float(np.max(np.abs(y)))
    peak_db = 20 * np.log10(peak) if peak > 0 else float("-inf")
    rms = float(np.sqrt(np.mean(np.square(y))))
    rms_db = 20 * np.log10(rms) if rms > 0 else float("-inf")
    crest_factor_db = peak_db - rms_db if np.isfinite(peak_db) and np.isfinite(rms_db) else None

    # Spectral centroid: the "center of mass" of the spectrum, in Hz. Higher
    # values read as a brighter/harsher mix, lower as darker/bassier.
    centroid = float(np.mean(librosa.feature.spectral_centroid(y=y, sr=sr)))

    return {
        "bpm": round(bpm, 1),
        "key": key,
        "key_confidence": round(key_confidence, 2),
        "integrated_lufs": round(lufs, 1) if np.isfinite(lufs) else None,
        "peak_db": round(peak_db, 1) if np.isfinite(peak_db) else None,
        "rms_db": round(rms_db, 1) if np.isfinite(rms_db) else None,
        "crest_factor_db": round(crest_factor_db, 1) if crest_factor_db is not None else None,
        "spectral_centroid_hz": round(centroid),
        "duration_seconds": round(len(y) / sr, 1),
        "sample_rate": sr,
    }


def warm_up() -> None:
    """Run one throwaway analysis so numba/librosa JIT-compile at startup
    instead of on the first real request."""
    import soundfile as sf
    import tempfile

    sr = 22050
    t = np.linspace(0, 1.0, sr, endpoint=False)
    tone = (0.2 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
    fd, path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        sf.write(path, tone, sr)
        analyze(path)
    finally:
        os.unlink(path)
