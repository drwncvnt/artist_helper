"""Audio Analyzer tool: upload a clip, get back BPM, musical key, loudness and
a few other level metrics. No reference track, no comparison - just the numbers
for the one clip you uploaded.

Analysis is CPU-bound (see analyze.py), so it runs in a small thread pool rather
than on the async event loop, keeping the server responsive under a few
concurrent requests without needing a visible queue like the heavier tools.
"""

import asyncio
import os
import subprocess
import uuid
from concurrent.futures import ThreadPoolExecutor

from fastapi import Depends, FastAPI, Header, HTTPException, UploadFile, status
from fastapi.responses import FileResponse

from . import analyze as analyze_module

STATIC_DIR = os.path.dirname(__file__)
UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "/data/uploads")

MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "40"))
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024
MAX_DURATION_SECONDS = int(os.environ.get("MAX_DURATION_SECONDS", "300"))
ALLOWED_EXTENSIONS = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac"}

app = FastAPI(title="analyzer API")
os.makedirs(UPLOAD_DIR, exist_ok=True)

# Two workers: enough to overlap a couple of requests without letting CPU-bound
# analyses pile up and starve each other on a small box.
_pool = ThreadPoolExecutor(max_workers=2)


@app.on_event("startup")
async def on_startup():
    # Runs in the pool too, so the first real request doesn't pay the JIT cost.
    asyncio.get_event_loop().run_in_executor(_pool, analyze_module.warm_up)


def current_user_id(x_auth_user_id: str | None = Header(default=None)) -> str:
    """Identity injected by the gateway. This service is only reachable through
    the gateway, which strips any client-supplied copy of this header."""
    if not x_auth_user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    return x_auth_user_id


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.get("/")
async def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"), media_type="text/html")


def _probe_duration(path: str) -> float | None:
    """Clip length in seconds via ffprobe, or None if it can't be determined."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True, timeout=15,
        )
        return float(out.stdout.strip())
    except (ValueError, subprocess.SubprocessError):
        return None


def _silent_unlink(path: str):
    try:
        os.unlink(path)
    except OSError:
        pass


@app.post("/api/analyze")
async def analyze_upload(file: UploadFile, user_id: str = Depends(current_user_id)):
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Unsupported file type. Use WAV, MP3, FLAC, OGG, M4A or AAC.")

    in_path = os.path.join(UPLOAD_DIR, uuid.uuid4().hex + ext)
    written = 0
    try:
        with open(in_path, "wb") as out:
            while True:
                chunk = await file.read(1024 * 256)
                if not chunk:
                    break
                written += len(chunk)
                if written > MAX_UPLOAD_BYTES:
                    out.close()
                    _silent_unlink(in_path)
                    raise HTTPException(status_code=413, detail=f"File too large (max {MAX_UPLOAD_MB} MB).")
                out.write(chunk)
    except HTTPException:
        raise
    except Exception:
        _silent_unlink(in_path)
        raise HTTPException(status_code=400, detail="Could not read the uploaded file.")

    duration = _probe_duration(in_path)
    if duration is None:
        _silent_unlink(in_path)
        raise HTTPException(status_code=400, detail="That doesn't look like a readable audio file.")
    if duration > MAX_DURATION_SECONDS:
        _silent_unlink(in_path)
        raise HTTPException(
            status_code=400,
            detail=f"Clip is too long ({duration:.0f}s). Please keep it under {MAX_DURATION_SECONDS}s.",
        )

    try:
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(_pool, analyze_module.analyze, in_path)
    except Exception:
        raise HTTPException(status_code=500, detail="Could not analyze that audio file.")
    finally:
        _silent_unlink(in_path)

    return result
