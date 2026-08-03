"""Background Remover tool: upload a photo, get back a PNG with the
background cut out. Segmentation is Spotify-adjacent open source model
`rembg` (ONNX, CPU-only in this deployment) - no reference image, single
shot, no job queue needed since a single inference is already sub-second
once the model is warm.

The model runs pinned to a small thread count (see OMP_NUM_THREADS in the
Dockerfile/compose entry) to match the CPU limit this service is deployed
under - see MAX_CONCURRENT_JOBS below for why that matters.
"""

import asyncio
import io
import os
from functools import lru_cache

from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, Response
from PIL import Image, ImageOps, UnidentifiedImageError

STATIC_DIR = os.path.dirname(__file__)

MODEL_NAME = os.environ.get("REMBG_MODEL", "isnet-general-use")
MAX_FILE_SIZE = int(os.environ.get("MAX_FILE_SIZE_MB", "15")) * 1024 * 1024
MAX_IMAGE_PIXELS = int(os.environ.get("MAX_IMAGE_PIXELS", "25000000"))
# Bounds how many inferences can run at once. Kept in sync with the CPU limit
# this container is given (see docker-compose.yml) - each inference already
# uses up to OMP_NUM_THREADS threads internally, so raising this without also
# raising the CPU allocation just adds thread contention, not throughput.
MAX_CONCURRENT_JOBS = max(1, int(os.environ.get("MAX_CONCURRENT_JOBS", "2")))
# A 3rd+ user doesn't get turned away - they queue and wait for one of the
# MAX_CONCURRENT_JOBS slots to free up. This caps how many can be waiting at
# once, so a genuine pathological burst still fails fast rather than growing
# the queue (and the memory held by each waiter's uploaded bytes) without end.
MAX_QUEUE_WAITING = max(0, int(os.environ.get("MAX_QUEUE_WAITING", "20")))
# A single inference should never legitimately take this long once warm. This
# is a backstop, not the expected case: without it, one wedged job (the same
# failure mode found and fixed in the transcribe tool) would hold its slot
# forever and freeze the queue for every waiting user, not just itself.
PROCESSING_TIMEOUT_SECONDS = 60
ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp"}

app = FastAPI(title="bgremove API")
inference_slots = asyncio.Semaphore(MAX_CONCURRENT_JOBS)
# Plain module-level counter, not a queue.Queue: only ever touched between
# awaits in this single-worker event loop, so no lock is needed, and
# asyncio.Semaphore already wakes waiters in FIFO order on its own.
_waiting_count = 0


def current_user_id(x_auth_user_id: str | None = Header(default=None)) -> str:
    """Identity injected by the gateway. This service is only reachable through
    the gateway, which strips any client-supplied copy of this header."""
    if not x_auth_user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    return x_auth_user_id


@lru_cache(maxsize=1)
def get_session():
    from rembg import new_session

    return new_session(MODEL_NAME)


def normalize_image(raw: bytes) -> bytes:
    """Decode, strip EXIF orientation into pixels, drop metadata, re-encode as
    PNG. Runs before the model so a corrupt/oversized upload is rejected
    without ever touching the (much more expensive) inference path."""
    try:
        with Image.open(io.BytesIO(raw)) as source:
            if source.width * source.height > MAX_IMAGE_PIXELS:
                raise HTTPException(
                    status_code=413,
                    detail=f"Image is too large. Max {MAX_IMAGE_PIXELS:,} pixels.",
                )
            source.load()
            image = ImageOps.exif_transpose(source)
            if image.mode not in {"RGB", "RGBA"}:
                image = image.convert("RGBA" if "transparency" in image.info else "RGB")
            clean = image.copy()
    except HTTPException:
        raise
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, ValueError) as exc:
        raise HTTPException(status_code=415, detail="Could not read that image.") from exc

    output = io.BytesIO()
    clean.save(output, format="PNG", optimize=True)
    return output.getvalue()


def remove_background(image: bytes) -> bytes:
    from rembg import remove

    result = remove(image, session=get_session(), force_return_bytes=True)
    if not isinstance(result, bytes):
        raise RuntimeError("Unexpected rembg response")
    return result


def _warm_up() -> None:
    """Load the ONNX session and run one throwaway inference at startup so the
    first real user request doesn't pay for session construction (~1 minute
    the first time a worker touches the model, observed empirically)."""
    tiny = Image.new("RGB", (32, 32), (128, 128, 128))
    buf = io.BytesIO()
    tiny.save(buf, format="PNG")
    remove_background(buf.getvalue())


@app.on_event("startup")
async def on_startup():
    await run_in_threadpool(_warm_up)


@app.get("/api/health")
async def health():
    return {"status": "ok", "model": MODEL_NAME}


@app.get("/")
async def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"), media_type="text/html")


@app.post("/api/remove")
async def remove_endpoint(
    file: UploadFile = File(...),
    user_id: str = Depends(current_user_id),
) -> Response:
    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(status_code=415, detail="Supported types: JPG, PNG, WebP.")

    raw = await file.read(MAX_FILE_SIZE + 1)
    await file.close()
    if not raw:
        raise HTTPException(status_code=400, detail="The file is empty.")
    if len(raw) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=413,
            detail=f"File is too large. Max {MAX_FILE_SIZE // (1024 * 1024)} MB.",
        )

    # Only MAX_CONCURRENT_JOBS requests ever hold the slot below at once; a
    # 3rd/4th/etc. user joins the queue and genuinely waits their turn rather
    # than being told to retry. The count check happens before touching the
    # semaphore so a queue that's already deep fails new arrivals immediately
    # instead of growing forever.
    global _waiting_count
    if _waiting_count >= MAX_QUEUE_WAITING:
        raise HTTPException(status_code=503, detail="The queue is full right now. Please try again shortly.")
    _waiting_count += 1
    try:
        await inference_slots.acquire()
    finally:
        _waiting_count -= 1

    # The slot covers decode+normalize as well as inference, not just the
    # model call: FastAPI's threadpool would otherwise happily decode dozens
    # of images (each a full pixel buffer) in parallel while they all wait
    # for their turn at the model, which is exactly how a burst of concurrent
    # uploads was observed to push this container's RSS past its 2-CPU/3GB
    # allocation and get OOM-killed.
    try:
        normalized = await run_in_threadpool(normalize_image, raw)
        try:
            result = await asyncio.wait_for(
                run_in_threadpool(remove_background, normalized), timeout=PROCESSING_TIMEOUT_SECONDS
            )
        except asyncio.TimeoutError:
            raise HTTPException(status_code=504, detail="Processing took too long. Please try again.")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail="Could not process that image.") from exc
    finally:
        inference_slots.release()

    return Response(
        content=result,
        media_type="image/png",
        headers={
            "Cache-Control": "no-store",
            "Content-Disposition": 'inline; filename="cutout.png"',
        },
    )
