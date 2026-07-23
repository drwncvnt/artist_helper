"""Audio -> MIDI tool.

An artist uploads a short audio clip and a tempo; the service transcribes it to
a MIDI file. Transcription is capped at two concurrent jobs (see jobs.py); extra
requests wait in a queue and can poll their position.

The web process stays light — it validates uploads and tracks jobs, while the
actual model runs in separate worker processes.
"""

import os
import subprocess
import uuid

from fastapi import Depends, FastAPI, Form, Header, HTTPException, UploadFile, status
from fastapi.responses import FileResponse

from .jobs import JobManager

STATIC_DIR = os.path.dirname(__file__)
WORK_DIR = os.environ.get("WORK_DIR", "/data/work")
UPLOAD_DIR = os.path.join(WORK_DIR, "uploads")

MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "25"))
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024
MAX_DURATION_SECONDS = int(os.environ.get("MAX_DURATION_SECONDS", "60"))
ALLOWED_EXTENSIONS = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac"}

app = FastAPI(title="transcribe API")
os.makedirs(UPLOAD_DIR, exist_ok=True)
manager = JobManager(WORK_DIR)


def current_user_id(x_auth_user_id: str | None = Header(default=None)) -> str:
    """Identity injected by the gateway. This service is only reachable through
    the gateway, which strips any client-supplied copy of this header."""
    if not x_auth_user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    return x_auth_user_id


@app.get("/api/health")
async def health():
    return {"status": "ok", "queue_depth": manager.queue_depth()}


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


@app.post("/api/analyze")
async def analyze_upload(
    file: UploadFile,
    tempo: float = Form(...),
    quantize: str = Form("0"),
    user_id: str = Depends(current_user_id),
):
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Unsupported file type. Use WAV, MP3, FLAC, OGG, M4A or AAC.")

    try:
        tempo_val = max(20.0, min(300.0, float(tempo)))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Tempo must be a number.")
    quantize_val = str(quantize).lower() in ("1", "true", "on", "yes")

    # Stream the upload to disk with a hard size cap.
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
        job_id = manager.submit(user_id, in_path, tempo_val, quantize_val, file.filename or "audio")
    except RuntimeError as exc:
        _silent_unlink(in_path)
        raise HTTPException(status_code=503, detail=str(exc))

    return {"job_id": job_id}


@app.get("/api/jobs/{job_id}")
async def job_status(job_id: str, user_id: str = Depends(current_user_id)):
    result = manager.status(job_id, user_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Job not found.")
    return result


@app.get("/api/jobs/{job_id}/download")
async def job_download(job_id: str, user_id: str = Depends(current_user_id)):
    out_path, filename = manager.output_path(job_id, user_id)
    if not out_path or not os.path.isfile(out_path):
        raise HTTPException(status_code=404, detail="Result not ready.")
    stem = os.path.splitext(os.path.basename(filename))[0] or "transcription"
    return FileResponse(out_path, media_type="audio/midi", filename=f"{stem}.mid")


def _silent_unlink(path: str):
    try:
        os.unlink(path)
    except OSError:
        pass
