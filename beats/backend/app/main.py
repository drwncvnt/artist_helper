import json
import math
import os
from contextlib import asynccontextmanager

from fastapi import Body, Depends, FastAPI, HTTPException, Request, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import db, storage
from .auth import CurrentUser, optional_session, require_session
from .config import settings
from .signing import sign_track, track_id_from_token, verify_track_token

STATIC_DIR = os.environ.get("STATIC_DIR", "/app/static")
LISTEN_PAGE = os.path.join(os.path.dirname(__file__), "listen.html")
# Multipart framing plus the small text fields that travel with the file.
FORM_OVERHEAD_BYTES = 1024 * 1024


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    yield


app = FastAPI(title="beats API", lifespan=lifespan)


@app.middleware("http")
async def no_index_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Robots-Tag"] = "noindex, nofollow, noarchive"
    return response


def _can_listen(meta: dict, user: CurrentUser) -> bool:
    return meta["is_public"] or meta["uploader_id"] == user.id


def _own_track(track_id: str, user: CurrentUser) -> dict:
    """Metadata of a track the user uploaded; 404 for anything else, so other
    people's private track ids can't be probed."""
    meta = db.get_track_meta(track_id)
    if not meta or meta["uploader_id"] != user.id:
        raise HTTPException(status_code=404, detail="Track not found")
    return meta


def _parse_waveform(raw) -> list[float] | None:
    """The client-computed peak list: at most 200 finite numbers, clamped to a
    sane range. Anything else is dropped rather than stored."""
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(data, list):
        return None
    peaks = []
    for value in data[:200]:
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            return None
        peaks.append(round(min(max(float(value), 0.0), 4.0), 4))
    return peaks or None


def _parse_duration(raw) -> float | None:
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) and 0 < value < 86400 else None


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.get("/api/me")
def me(user: CurrentUser = Depends(require_session)):
    return {"id": user.id, "username": user.username}


@app.get("/api/tracks")
def get_tracks(user: CurrentUser = Depends(require_session)):
    """Library visible to the signed-in user: their own tracks (public or
    private) plus everyone else's public tracks."""
    on_disk = storage.list_tracks()
    meta = db.get_tracks_meta_by_id()
    tracks = []
    for entry in on_disk:
        m = meta.get(entry["id"])
        if not m:
            continue  # a file with no metadata row — skip
        mine = m["uploader_id"] == user.id
        if not (m["is_public"] or mine):
            continue  # someone else's private track — hidden
        tracks.append({
            **entry,
            "title": m["title"],
            "description": m["description"],
            "is_public": m["is_public"],
            "uploader": m["uploader"],
            "mine": mine,
            "duration_seconds": m["duration_seconds"],
            "waveform": m["waveform"],
            "play_count": m["play_count"],
        })
    tracks.sort(key=lambda t: t.get("modified", 0), reverse=True)
    return {
        "tracks": tracks,
        "quota": {"used_bytes": db.storage_used_by(user.id), "limit_bytes": settings.user_quota_bytes},
    }


@app.post("/api/upload")
async def upload_track(request: Request, user: CurrentUser = Depends(require_session)):
    # Every limit is checked against Content-Length before the body is read,
    # so a request that can't succeed is refused without being received.
    declared_raw = request.headers.get("content-length", "")
    if not declared_raw.isdigit():
        raise HTTPException(status_code=411, detail="Content-Length required")
    declared = int(declared_raw)
    if declared > settings.max_upload_bytes + FORM_OVERHEAD_BYTES:
        raise HTTPException(status_code=413, detail=f"File too large (max {settings.max_upload_mb} MB)")

    used = await run_in_threadpool(db.storage_used_by, user.id)
    if used + declared > settings.user_quota_bytes + FORM_OVERHEAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Not enough space left in your library (limit {settings.user_quota_mb} MB). Delete a track to make room.",
        )
    if storage.free_disk_bytes() - declared < settings.min_free_disk_bytes:
        raise HTTPException(status_code=507, detail="Storage is full right now. Please try again later.")

    form = await request.form(max_files=1, max_fields=10, max_part_size=FORM_OVERHEAD_BYTES)
    upload: UploadFile | None = form.get("file")
    if upload is None or isinstance(upload, str):
        raise HTTPException(status_code=400, detail="No file provided")

    title = (form.get("title") or "").strip()[:120] or None
    description = (form.get("description") or "").strip()[:2000] or None
    is_public = str(form.get("is_public", "")).lower() in ("1", "true", "on", "yes")
    duration = _parse_duration(form.get("duration"))
    waveform = _parse_waveform(form.get("waveform"))

    track_id = await storage.save_upload(upload)
    size = storage.file_size(track_id) or 0
    await run_in_threadpool(
        db.create_track_meta,
        track_id, (upload.filename or track_id)[:255], user.id, duration, waveform,
        title, description, is_public, size,
    )
    # Re-check with the real size; two parallel uploads could both have
    # passed the estimate above.
    if await run_in_threadpool(db.storage_used_by, user.id) > settings.user_quota_bytes:
        await run_in_threadpool(db.delete_track_meta, track_id)
        storage.delete_track_file(track_id)
        raise HTTPException(
            status_code=413,
            detail=f"Not enough space left in your library (limit {settings.user_quota_mb} MB). Delete a track to make room.",
        )
    return {"id": track_id}


@app.post("/api/tracks/{track_id}/play")
def register_play(track_id: str, user: CurrentUser = Depends(require_session)):
    meta = db.get_track_meta(track_id)
    if not meta or not _can_listen(meta, user):
        raise HTTPException(status_code=404, detail="Track not found")
    db.increment_play_count(track_id)
    return {"status": "ok"}


@app.patch("/api/tracks/{track_id}")
def update_track(
    track_id: str,
    is_public: bool = Body(..., embed=True),
    user: CurrentUser = Depends(require_session),
):
    _own_track(track_id, user)
    db.set_visibility(track_id, is_public)
    return {"id": track_id, "is_public": is_public}


@app.delete("/api/tracks/{track_id}")
def delete_track(track_id: str, user: CurrentUser = Depends(require_session)):
    _own_track(track_id, user)
    storage.delete_track_file(track_id)
    db.delete_track_meta(track_id)
    return {"status": "deleted"}


@app.delete("/api/me/data")
def delete_my_data(user: CurrentUser = Depends(require_session)):
    """Removes every track the user uploaded plus their local user record.
    Called by the gateway when the platform account is deleted."""
    track_ids = db.track_ids_by_uploader(user.id)
    for track_id in track_ids:
        storage.delete_track_file(track_id)
    db.delete_user(user.id)
    return {"status": "deleted", "tracks": len(track_ids)}


@app.get("/api/tracks/{track_id}/share")
def get_share_link(track_id: str, user: CurrentUser = Depends(require_session)):
    """Issue a public share link for a track the user can access (their own, or
    any public track)."""
    meta = db.get_track_meta(track_id)
    if not meta or not _can_listen(meta, user):
        raise HTTPException(status_code=404, detail="Track not found")
    token = sign_track(track_id)
    return {
        "token": token,
        "path": f"listen/{token}",  # frontend prefixes with the /beats mount
        "expires_in_seconds": settings.share_ttl_seconds,
    }


@app.get("/api/stream/{track_id}")
def stream_track_endpoint(
    track_id: str,
    request: Request,
    token: str | None = None,
    user: CurrentUser | None = Depends(optional_session),
):
    # A valid share token for this exact track is enough on its own. Without
    # one, the signed-in user must be allowed to listen: their own track or a
    # public one. Knowing a private track's id is not enough.
    if not (token is not None and verify_track_token(token, track_id)):
        if user is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
        meta = db.get_track_meta(track_id)
        if not meta or not _can_listen(meta, user):
            raise HTTPException(status_code=404, detail="Track not found")

    path = storage.resolve_track_path(track_id)
    return storage.stream_track(path, request.headers.get("range"))


# ---- Public share surface (no account required; a valid token is the key) ----

@app.get("/api/public/track")
def public_track_meta(token: str):
    """Metadata for a shared track, for the public listen page. Requires a valid
    share token; returns only fields safe to show to an anonymous listener."""
    track_id = track_id_from_token(token)
    if not track_id:
        raise HTTPException(status_code=404, detail="Link expired or invalid")
    meta = db.get_track_meta(track_id)
    if not meta:
        raise HTTPException(status_code=404, detail="Track not found")
    return {
        "id": track_id,
        "title": meta["title"],
        "description": meta["description"],
        "uploader": meta["uploader"],
        "duration_seconds": meta["duration_seconds"],
        "waveform": meta["waveform"],
        "stream_path": f"api/stream/{track_id}?token={token}",
    }


@app.get("/listen/{token}")
async def listen_page(token: str):
    """Public listen page for a shared track (served for any token; the page
    itself validates the token via /api/public/track)."""
    return FileResponse(LISTEN_PAGE, media_type="text/html")


# The built React SPA is served at the root. This mount MUST be registered after
# all /api and /listen routes so it only catches non-API paths (index + assets).
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="spa")
