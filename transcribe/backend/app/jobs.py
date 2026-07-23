"""Job manager: a global cap of two concurrent transcriptions, everything else
waits in a FIFO queue.

Transcription is CPU-heavy and slow to warm up, so it runs in a
``ProcessPoolExecutor`` of exactly two worker processes (each loads the model
once). A semaphore of the same size gates *dispatch*, so at most two jobs are
ever in flight; additional jobs sit in an ordered queue and can report their
position. All state lives in this single web process — the workers only receive
file paths and hand back a result.
"""

import os
import queue
import threading
import time
import uuid
from concurrent.futures import ProcessPoolExecutor

from . import analyze

MAX_CONCURRENT = 2          # never run more than this many transcriptions at once
MAX_QUEUE = 40              # reject new jobs beyond this backlog
JOB_TTL_SECONDS = 30 * 60   # forget finished jobs (and delete their files) after this


class JobManager:
    def __init__(self, work_dir: str):
        self.work_dir = work_dir
        os.makedirs(work_dir, exist_ok=True)

        self._jobs = {}                       # job_id -> record dict
        self._order = []                      # job_ids still queued, in FIFO order
        self._lock = threading.Lock()
        self._queue = queue.Queue()           # job_ids waiting to be dispatched
        self._slots = threading.Semaphore(MAX_CONCURRENT)
        self._executor = ProcessPoolExecutor(
            max_workers=MAX_CONCURRENT, initializer=analyze.worker_init
        )

        self._dispatcher = threading.Thread(target=self._dispatch_loop, daemon=True)
        self._dispatcher.start()
        self._sweeper = threading.Thread(target=self._sweep_loop, daemon=True)
        self._sweeper.start()
        # Spawn and warm both workers up front so the first real jobs are fast.
        threading.Thread(target=self._warm_pool, daemon=True).start()

    def _warm_pool(self):
        futures = [self._executor.submit(analyze.warm_noop) for _ in range(MAX_CONCURRENT)]
        for f in futures:
            try:
                f.result()
            except Exception:
                pass

    # -- public API ---------------------------------------------------------

    def queue_depth(self) -> int:
        with self._lock:
            return len(self._order)

    def submit(self, user_id, in_path, tempo, quantize, filename) -> str:
        """Enqueue a transcription. Raises RuntimeError if the backlog is full."""
        with self._lock:
            if len(self._order) >= MAX_QUEUE:
                raise RuntimeError("The queue is full right now. Please try again in a moment.")
            job_id = uuid.uuid4().hex
            self._jobs[job_id] = {
                "id": job_id,
                "user_id": user_id,
                "status": "queued",
                "in_path": in_path,
                "out_path": os.path.join(self.work_dir, job_id + ".mid"),
                "tempo": tempo,
                "quantize": quantize,
                "filename": filename,
                "note_count": None,
                "error": None,
                "created_at": time.time(),
                "finished_at": None,
            }
            self._order.append(job_id)
        self._queue.put(job_id)
        return job_id

    def status(self, job_id, user_id):
        """Status for a job the given user owns, or None if not found/theirs."""
        with self._lock:
            rec = self._jobs.get(job_id)
            if rec is None or rec["user_id"] != user_id:
                return None
            out = {
                "status": rec["status"],
                "note_count": rec["note_count"],
                "error": rec["error"],
            }
            if rec["status"] == "queued":
                # 0 = next to run once a slot frees.
                out["position"] = self._order.index(job_id) if job_id in self._order else 0
                out["ahead"] = out["position"]
            return out

    def output_path(self, job_id, user_id):
        """Path to a finished job's MIDI, if the user owns it and it's ready."""
        with self._lock:
            rec = self._jobs.get(job_id)
            if rec is None or rec["user_id"] != user_id or rec["status"] != "done":
                return None, None
            return rec["out_path"], rec["filename"]

    # -- internals ----------------------------------------------------------

    def _dispatch_loop(self):
        while True:
            job_id = self._queue.get()
            # Wait for a free slot before starting — this is what caps concurrency.
            self._slots.acquire()
            with self._lock:
                rec = self._jobs.get(job_id)
                if rec is None:            # swept away before it ran
                    self._slots.release()
                    continue
                rec["status"] = "processing"
                if job_id in self._order:
                    self._order.remove(job_id)
            future = self._executor.submit(
                analyze.transcribe, rec["in_path"], rec["out_path"], rec["tempo"], rec["quantize"]
            )
            future.add_done_callback(lambda f, jid=job_id: self._on_done(jid, f))

    def _on_done(self, job_id, future):
        with self._lock:
            rec = self._jobs.get(job_id)
            if rec is not None:
                try:
                    rec["note_count"] = future.result()
                    rec["status"] = "done"
                except Exception as exc:  # transcription failed in the worker
                    rec["status"] = "error"
                    rec["error"] = "Could not transcribe that audio."
                    rec["note_count"] = None
                    print("transcribe job failed:", repr(exc))
                rec["finished_at"] = time.time()
                in_path = rec["in_path"]
            else:
                in_path = None
        if in_path:
            _silent_unlink(in_path)
        self._slots.release()

    def _sweep_loop(self):
        while True:
            time.sleep(300)
            cutoff = time.time() - JOB_TTL_SECONDS
            expired = []
            with self._lock:
                for job_id, rec in list(self._jobs.items()):
                    ref = rec["finished_at"] or rec["created_at"]
                    if rec["status"] in ("done", "error") and ref < cutoff:
                        expired.append(rec)
                        del self._jobs[job_id]
            for rec in expired:
                _silent_unlink(rec["in_path"])
                _silent_unlink(rec["out_path"])


def _silent_unlink(path):
    try:
        os.unlink(path)
    except OSError:
        pass
