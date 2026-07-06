import os
import re
import uuid
from pathlib import Path

from fastapi import HTTPException
from starlette.responses import StreamingResponse

from .config import settings

ALLOWED_EXTENSIONS = {".mp3", ".wav", ".flac", ".m4a", ".ogg", ".aac"}
_SAFE_CHARS = re.compile(r"[^a-zA-Z0-9._-]+")

STORAGE_ROOT = Path(settings.storage_dir).resolve()
STORAGE_ROOT.mkdir(parents=True, exist_ok=True)


def sanitize_filename(original_name: str) -> str:
    name = os.path.basename(original_name)
    stem, ext = os.path.splitext(name)
    ext = ext.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {ext or 'unknown'}")
    stem = _SAFE_CHARS.sub("-", stem)[:80] or "track"
    return f"{uuid.uuid4().hex[:8]}-{stem}{ext}"


def resolve_track_path(track_id: str) -> Path:
    """Resolves a track id to a path, guaranteed to stay within STORAGE_ROOT."""
    candidate = (STORAGE_ROOT / os.path.basename(track_id)).resolve()
    if STORAGE_ROOT not in candidate.parents and candidate != STORAGE_ROOT:
        raise HTTPException(status_code=400, detail="Invalid track id")
    if not candidate.is_file():
        raise HTTPException(status_code=404, detail="Track not found")
    return candidate


def list_tracks() -> list[dict]:
    tracks = []
    for entry in sorted(STORAGE_ROOT.iterdir()):
        if entry.is_file() and entry.suffix.lower() in ALLOWED_EXTENSIONS:
            stat = entry.stat()
            tracks.append({
                "id": entry.name,
                "size_bytes": stat.st_size,
                "modified": int(stat.st_mtime),
            })
    return tracks


def _iter_file_range(path: Path, start: int, end: int, chunk_size: int = 1024 * 256):
    with open(path, "rb") as f:
        f.seek(start)
        remaining = end - start + 1
        while remaining > 0:
            chunk = f.read(min(chunk_size, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


def stream_track(path: Path, range_header: str | None) -> StreamingResponse:
    file_size = path.stat().st_size
    media_type = {
        ".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac",
        ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".aac": "audio/aac",
    }.get(path.suffix.lower(), "application/octet-stream")

    if range_header:
        match = re.match(r"bytes=(\d*)-(\d*)", range_header)
        if not match:
            raise HTTPException(status_code=416, detail="Invalid Range header")
        start_s, end_s = match.groups()
        start = int(start_s) if start_s else 0
        end = int(end_s) if end_s else file_size - 1
        end = min(end, file_size - 1)
        if start > end or start >= file_size:
            raise HTTPException(status_code=416, detail="Requested range not satisfiable")
        headers = {
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(end - start + 1),
        }
        return StreamingResponse(
            _iter_file_range(path, start, end),
            status_code=206,
            media_type=media_type,
            headers=headers,
        )

    headers = {"Accept-Ranges": "bytes", "Content-Length": str(file_size)}
    return StreamingResponse(
        _iter_file_range(path, 0, file_size - 1),
        media_type=media_type,
        headers=headers,
    )


async def save_upload(file, declared_size: int | None) -> str:
    filename = sanitize_filename(file.filename or "track")
    dest = STORAGE_ROOT / filename

    if declared_size is not None and declared_size > settings.max_upload_bytes:
        raise HTTPException(status_code=413, detail="File too large")

    written = 0
    chunk_size = 1024 * 256
    with open(dest, "wb") as out:
        while True:
            chunk = await file.read(chunk_size)
            if not chunk:
                break
            written += len(chunk)
            if written > settings.max_upload_bytes:
                out.close()
                dest.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail="File too large")
            out.write(chunk)

    return filename
