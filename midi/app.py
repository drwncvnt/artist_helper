"""Algorithmic MIDI generator.

Builds a 256-note IDM-flavored sequence (minor scale with dissonances, octave
jumps, micro-timing and velocity spikes) and streams it back as a .mid file.

Generation logic is unchanged from the original standalone tool; only the UI was
restyled to the shared platform theme and the download link made path-relative
so it works when served under the gateway at /midi/.
"""

import io
import os
import random

import mido
from flask import Flask, send_file

app = Flask(__name__)

INDEX_PATH = os.path.join(os.path.dirname(__file__), "index.html")


@app.route("/")
def index():
    with open(INDEX_PATH, "r", encoding="utf-8") as f:
        return f.read()


@app.route("/generate")
def generate():
    mid = mido.MidiFile()
    track = mido.MidiTrack()
    mid.tracks.append(track)

    # Minor-ish scale with dissonances as the IDM base.
    scale = [36, 38, 43, 46, 48, 55, 60]

    for _ in range(256):
        # Algorithmic octave jumps.
        note = random.choice(scale) + random.choice([-12, 0, 12, 24])
        note = max(0, min(127, note))

        # Rhythmic math: micro-delays and sharp velocity spikes.
        time_on = random.choice([0, 0, 60, 120, 240])
        time_off = random.choice([30, 60, 120])
        velocity = random.randint(70, 127)

        track.append(mido.Message("note_on", note=note, velocity=velocity, time=time_on))
        track.append(mido.Message("note_off", note=note, velocity=127, time=time_off))

    mem = io.BytesIO()
    mid.save(file=mem)
    mem.seek(0)

    return send_file(
        mem,
        as_attachment=True,
        download_name="drwncvnt_chaos.mid",
        mimetype="audio/midi",
    )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=11000)
