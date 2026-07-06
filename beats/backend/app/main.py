import json
import os

from fastapi import Depends, FastAPI, Header, HTTPException, Request, UploadFile, status
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import db, storage
from .auth import CurrentUser, require_session
from .config import settings
from .signing import sign_track, track_id_from_token, verify_track_token

app = FastAPI(title="beats API")

STATIC_DIR = os.environ.get("STATIC_DIR", "/app/static")
LISTEN_PAGE = os.path.join(os.path.dirname(__file__), "listen.html")


@app.on_event("startup")
async def on_startup():
    db.init_db()


@app.middleware("http")
async def no_index_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Robots-Tag"] = "noindex, nofollow, noarchive"
    return response


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.get("/api/me")
async def me(user: CurrentUser = Depends(require_session)):
    return {"id": user.id, "username": user.username}


@app.get("/api/tracks")
async def get_tracks(user: CurrentUser = Depends(require_session)):
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
    return {"tracks": tracks}


@app.post("/api/upload")
async def upload_track(request: Request, user: CurrentUser = Depends(require_session)):
    form = await request.form()
    upload: UploadFile | None = form.get("file")
    if upload is None:
        raise HTTPException(status_code=400, detail="No file provided")

    title = (form.get("title") or "").strip()[:120] or None
    description = (form.get("description") or "").strip()[:2000] or None
    is_public = str(form.get("is_public", "")).lower() in ("1", "true", "on", "yes")

    duration_raw = form.get("duration")
    waveform_raw = form.get("waveform")
    duration = None
    waveform = None
    try:
        if duration_raw:
            duration = float(duration_raw)
        if waveform_raw:
            waveform = json.loads(waveform_raw)[:200]
    except (ValueError, TypeError):
        pass

    declared_size = request.headers.get("content-length")
    track_id = await storage.save_upload(upload, int(declared_size) if declared_size else None)
    db.create_track_meta(
        track_id, upload.filename or track_id, user.id, duration, waveform,
        title=title, description=description, is_public=is_public,
    )
    return {"id": track_id}


@app.post("/api/tracks/{track_id}/play")
async def register_play(track_id: str, _user: CurrentUser = Depends(require_session)):
    storage.resolve_track_path(track_id)
    db.increment_play_count(track_id)
    return {"status": "ok"}


@app.get("/api/tracks/{track_id}/share")
async def get_share_link(track_id: str, user: CurrentUser = Depends(require_session)):
    """Issue a public share link for a track the user can access (their own, or
    any public track)."""
    meta = db.get_track_meta(track_id)
    if not meta:
        raise HTTPException(status_code=404, detail="Track not found")
    if not (meta["is_public"] or meta["uploader_id"] == user.id):
        raise HTTPException(status_code=403, detail="Not allowed to share this track")
    token = sign_track(track_id)
    return {
        "token": token,
        "path": f"listen/{token}",  # frontend prefixes with the /beats mount
        "expires_in_seconds": settings.share_ttl_seconds,
    }


@app.get("/api/stream/{track_id}")
async def stream_track_endpoint(
    track_id: str,
    request: Request,
    token: str | None = None,
    x_auth_user_id: str | None = Header(default=None),
):
    # Authorized by a valid share token, or by the gateway-injected identity
    # header (a signed-in platform user).
    authorized = (token is not None and verify_track_token(token, track_id)) or bool(x_auth_user_id)
    if not authorized:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    path = storage.resolve_track_path(track_id)
    return storage.stream_track(path, request.headers.get("range"))


# ---- Public share surface (no account required; a valid token is the key) ----

@app.get("/api/public/track")
async def public_track_meta(token: str):
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
