"""Generative MIDI web tool.

Exposes a parameterised generative engine (see ``generator.py``) over HTTP:

* ``GET /``          -> the single-page UI (index.html)
* ``GET /generate``  -> a downloadable ``.mid`` built from the query params
* ``GET /preview``   -> the same material as JSON, for in-browser Web Audio playback

Both data routes take identical query params and, for a given seed, produce the
same notes -- so what you hear in the preview is exactly what you download.
All inputs are clamped to safe ranges; bad input never 500s.

Served behind the platform gateway at ``/midi/``; links are path-relative.
"""

import io
import os

from flask import Flask, jsonify, request, send_file

import generator
from generator import Params

app = Flask(__name__)

INDEX_PATH = os.path.join(os.path.dirname(__file__), "index.html")


# ---------------------------------------------------------------------------
# Input parsing -- clamp everything, trust nothing
# ---------------------------------------------------------------------------

def _clamp_int(value, lo, hi, default):
    try:
        return max(lo, min(hi, int(value)))
    except (TypeError, ValueError):
        return default


def _one_of(value, allowed, default):
    return value if value in allowed else default


def parse_params(args) -> Params:
    p = Params()
    p.key = _one_of(args.get("key"), generator.NOTE_NAMES, "C")
    p.scale = _one_of(args.get("scale"), generator.SCALES, "natural_minor")
    p.engine = _one_of(args.get("engine"), generator.ENGINE_FUNCS, "random_walk")
    p.subdivision = _one_of(args.get("subdivision"), generator.SUBDIVISIONS, "16")
    p.arp_pattern = _one_of(args.get("arp_pattern"), generator.ARP_PATTERNS, "updown")

    p.bpm = _clamp_int(args.get("bpm"), 40, 240, 120)
    p.bars = _clamp_int(args.get("bars"), 1, 64, 8)
    p.swing = _clamp_int(args.get("swing"), 0, 100, 0)
    p.octave_low = _clamp_int(args.get("octave_low"), 0, 8, 3)
    p.octave_high = _clamp_int(args.get("octave_high"), 0, 8, 5)
    p.density = _clamp_int(args.get("density"), 1, 100, 80)
    p.rest_prob = _clamp_int(args.get("rest_prob"), 0, 90, 10)
    p.velocity_min = _clamp_int(args.get("velocity_min"), 1, 127, 70)
    p.velocity_max = _clamp_int(args.get("velocity_max"), 1, 127, 120)
    p.humanize = _clamp_int(args.get("humanize"), 0, 100, 20)
    p.seed = _clamp_int(args.get("seed"), 0, 2_000_000_000, 0)
    p.chords = args.get("chords") in ("1", "true", "on", "yes")

    # keep ranges coherent
    if p.octave_low > p.octave_high:
        p.octave_low, p.octave_high = p.octave_high, p.octave_low
    if p.velocity_min > p.velocity_max:
        p.velocity_min, p.velocity_max = p.velocity_max, p.velocity_min
    return p


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    with open(INDEX_PATH, "r", encoding="utf-8") as f:
        return f.read()


@app.route("/generate")
def generate():
    params = parse_params(request.args)
    notes, meta = generator.build(params)
    mid = generator.notes_to_midi(notes, meta)

    mem = io.BytesIO()
    mid.save(file=mem)
    mem.seek(0)

    resp = send_file(
        mem,
        as_attachment=True,
        download_name=f"drwncvnt_{meta.engine}_{meta.seed}.mid",
        mimetype="audio/midi",
    )
    resp.headers["X-Seed"] = str(meta.seed)
    return resp


@app.route("/preview")
def preview():
    params = parse_params(request.args)
    notes, meta = generator.build(params)
    return jsonify(generator.notes_to_json(notes, meta))


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=11000)
