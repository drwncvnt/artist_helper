"""Audio Analyzer tool: upload a clip, get back BPM, musical key, loudness and
a few other level metrics. No reference track, no comparison - just the numbers
for the one clip you uploaded.

Analysis is CPU-bound (see analyze.py), so it runs in a small thread pool rather
than on the async event loop, keeping the server responsive under a few
concurrent requests without needing a visible queue like the heavier tools.
"""

import asyncio
import hmac
import json
import os
import subprocess
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse

from . import analyze as analyze_module

STATIC_DIR = os.path.dirname(__file__)
UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "/data/uploads")

MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "40"))
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024
MAX_DURATION_SECONDS = int(os.environ.get("MAX_DURATION_SECONDS", "300"))
ALLOWED_EXTENSIONS = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac"}
GATEWAY_SECRET = os.environ.get("GATEWAY_SECRET", "")

# Two workers: enough to overlap a couple of requests without letting CPU-bound
# analyses pile up and starve each other on a small box.
MAX_CONCURRENT = 2
_pool = ThreadPoolExecutor(max_workers=MAX_CONCURRENT)
# Requests beyond the running ones wait for a slot, but only a few of them and
# only for so long: the whole request has to finish within Cloudflare's 100 s
# limit, so an endless queue would just turn into timeouts.
MAX_QUEUE_WAITING = int(os.environ.get("MAX_QUEUE_WAITING", "6"))
QUEUE_WAIT_SECONDS = 45
_waiting = 0


class SampleBudget:
    """Admits analyses while the audio in flight stays within a sample budget.

    An analysis's peak memory grows linearly with its sample count (one
    5-minute 48 kHz clip peaks around 1.5 GB above the idle process), so a
    plain "two at a time" limit lets two long clips exhaust the container.
    The budget is one maximum-length clip: two short clips still run side by
    side, two long ones take turns.
    """

    def __init__(self, budget: int, max_jobs: int):
        self.budget = budget
        self.max_jobs = max_jobs
        self.in_use = 0
        self.jobs = 0
        self._cond = asyncio.Condition()

    async def acquire(self, cost: int) -> int:
        cost = min(cost, self.budget)
        async with self._cond:
            await self._cond.wait_for(lambda: self.jobs < self.max_jobs and self.in_use + cost <= self.budget)
            self.in_use += cost
            self.jobs += 1
        return cost

    async def release(self, cost: int) -> None:
        async with self._cond:
            self.in_use -= cost
            self.jobs -= 1
            self._cond.notify_all()


_budget = SampleBudget(MAX_DURATION_SECONDS * analyze_module.MAX_SAMPLE_RATE, MAX_CONCURRENT)
# One analysis per user at a time, so a single account can't occupy every slot.
_active_users: set[str] = set()


@asynccontextmanager
async def lifespan(app: FastAPI):
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    # Runs in the pool too, so the first real request doesn't pay the JIT cost.
    asyncio.get_running_loop().run_in_executor(_pool, analyze_module.warm_up)
    yield


app = FastAPI(title="analyzer API", lifespan=lifespan)


def current_user_id(
    x_auth_user_id: str | None = Header(default=None),
    x_gateway_secret: str | None = Header(default=None),
) -> str:
    """Identity injected by the gateway. The shared secret proves the request
    came through the gateway (which strips client-supplied copies of these
    headers) rather than from another container on the network."""
    from_gateway = bool(GATEWAY_SECRET) and bool(x_gateway_secret) and hmac.compare_digest(
        x_gateway_secret.encode(), GATEWAY_SECRET.encode()
    )
    if not from_gateway or not x_auth_user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    return x_auth_user_id


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.get("/")
async def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"), media_type="text/html")


def _probe(path: str) -> tuple[float | None, int | None]:
    """(duration in seconds, sample rate) via ffprobe; either is None if it
    can't be determined."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a:0",
             "-show_entries", "format=duration:stream=sample_rate", "-of", "json", path],
            capture_output=True, text=True, timeout=15,
        )
        info = json.loads(out.stdout or "{}")
    except (ValueError, subprocess.SubprocessError):
        return None, None
    try:
        duration = float(info["format"]["duration"])
    except (KeyError, TypeError, ValueError):
        duration = None
    try:
        sample_rate = int(info["streams"][0]["sample_rate"])
    except (KeyError, IndexError, TypeError, ValueError):
        sample_rate = None
    return duration, sample_rate


def _silent_unlink(path: str):
    try:
        os.unlink(path)
    except OSError:
        pass


@app.post("/api/analyze")
async def analyze_upload(file: UploadFile, user_id: str = Depends(current_user_id)):
    global _waiting
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Unsupported file type. Use WAV, MP3, FLAC, OGG, M4A or AAC.")
    if user_id in _active_users:
        raise HTTPException(status_code=429, detail="You already have an analysis running. Please wait for it to finish.")

    _active_users.add(user_id)
    in_path = os.path.join(UPLOAD_DIR, uuid.uuid4().hex + ext)
    try:
        written = 0
        try:
            with open(in_path, "wb") as out:
                while True:
                    chunk = await file.read(1024 * 256)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > MAX_UPLOAD_BYTES:
                        raise HTTPException(status_code=413, detail=f"File too large (max {MAX_UPLOAD_MB} MB).")
                    out.write(chunk)
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(status_code=400, detail="Could not read the uploaded file.")

        duration, sample_rate = await run_in_threadpool(_probe, in_path)
        if duration is None:
            raise HTTPException(status_code=400, detail="That doesn't look like a readable audio file.")
        if duration > MAX_DURATION_SECONDS:
            raise HTTPException(
                status_code=400,
                detail=f"Clip is too long ({duration:.0f}s). Please keep it under {MAX_DURATION_SECONDS}s.",
            )

        if _waiting >= MAX_QUEUE_WAITING:
            raise HTTPException(status_code=503, detail="The analyzer is busy right now. Please try again in a minute.")
        effective_rate = min(sample_rate or analyze_module.MAX_SAMPLE_RATE, analyze_module.MAX_SAMPLE_RATE)
        _waiting += 1
        try:
            async with asyncio.timeout(QUEUE_WAIT_SECONDS):
                cost = await _budget.acquire(int(duration * effective_rate))
        except TimeoutError:
            raise HTTPException(status_code=503, detail="The analyzer is busy right now. Please try again in a minute.")
        finally:
            _waiting -= 1

        try:
            loop = asyncio.get_running_loop()
            return await loop.run_in_executor(_pool, analyze_module.analyze, in_path, sample_rate)
        except Exception:
            raise HTTPException(status_code=500, detail="Could not analyze that audio file.")
        finally:
            await _budget.release(cost)
    finally:
        _active_users.discard(user_id)
        _silent_unlink(in_path)
