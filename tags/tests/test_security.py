"""Regression tests for upload handling in the tag editor.

Run from tags/:  pip install -r backend/requirements.txt pytest httpx
                 pytest tests
"""

import io
import os
import sys
import tempfile
import wave
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image  # noqa: E402

from app.main import app  # noqa: E402

client = TestClient(app)


def wav_bytes() -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(8000)
        w.writeframes(b"\0\0" * 800)
    return buf.getvalue()


def png_bytes() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (4, 4), (200, 0, 0)).save(buf, format="PNG")
    return buf.getvalue()


@pytest.mark.parametrize("name", [
    "../../../../tmp/pwned.wav",
    "/tmp/pwned.wav",
    "..\\..\\..\\tmp\\pwned.wav",
])
def test_upload_name_never_chooses_the_server_path(name):
    target = Path(tempfile.gettempdir()) / "pwned.wav"
    target.unlink(missing_ok=True)
    res = client.post("/api/save", files={"file": (name, wav_bytes(), "audio/wav")}, data={"title": "x"})
    assert res.status_code == 200
    assert not target.exists()
    assert not Path("/pwned.wav").exists()
    assert 'filename="pwned.wav"' in res.headers["content-disposition"]


def test_non_audio_extensions_are_refused():
    res = client.post("/api/save", files={"file": ("../../app/app/index.html", b"<script>", "text/html")})
    assert res.status_code == 400
    res = client.post("/api/read", files={"file": ("x.html", b"<script>", "text/html")})
    assert res.status_code == 400


def test_garbage_audio_is_a_client_error_not_a_crash():
    assert client.post("/api/read", files={"file": ("x.mp3", b"not audio", "audio/mpeg")}).status_code == 400
    res = client.post("/api/save", files={"file": ("x.flac", b"not audio", "audio/flac")})
    assert res.status_code in (400, 500)
    assert "Traceback" not in res.text and "/tmp" not in res.text


def test_cover_must_be_an_image():
    res = client.post(
        "/api/save",
        files={"file": ("a.wav", wav_bytes(), "audio/wav"), "cover_file": ("c.png", b"nope", "image/png")},
    )
    assert res.status_code == 400


def test_round_trip_with_cover():
    res = client.post(
        "/api/save",
        files={"file": ("a.wav", wav_bytes(), "audio/wav"), "cover_file": ("c.png", png_bytes(), "image/png")},
        data={"title": "Healing Process", "artist": "drwncvnt", "bpm": "140"},
    )
    assert res.status_code == 200
    # Still a valid RIFF file: tags live in its id3 chunk, not in front of it.
    assert res.content[:4] == b"RIFF"
    read = client.post("/api/read", files={"file": ("a.wav", res.content, "audio/wav")}).json()
    assert read["tags"]["title"] == "Healing Process"
    assert read["tags"]["bpm"] == "140"
    assert read["cover"]["mime"] == "image/png"
