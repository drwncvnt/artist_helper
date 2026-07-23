"""Job manager: a global cap of two concurrent transcriptions, everything else
waits in a FIFO queue.

Transcription is CPU-heavy and slow to warm up, so it runs in a
``ProcessPoolExecutor`` of exactly two worker processes (each loads the model
once). A semaphore of the same size gates *dispatch*, so at most two jobs are
ever in flight; additional jobs sit in an ordered queue and can report their
position. All state lives in this single web process — the workers only receive
file paths and hand back a result.
"""

import multiprocessing
import os
import queue
import threading
import time
import uuid
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool

from . import analyze

MAX_CONCURRENT = 2          # never run more than this many transcriptions at once
MAX_QUEUE = 40              # reject new jobs beyond this backlog
JOB_TTL_SECONDS = 30 * 60   # forget finished jobs (and delete their files) after this
JOB_TIMEOUT_SECONDS = 180   # generous vs. the 60s max clip length + model overhead;
                            # a job still running past this is treated as a wedged worker

# Worker processes must be spawned, not forked: this process starts several
# background threads (dispatcher, sweeper, warm-up) before the pool's first
# submit(), and forking a multi-threaded process can hand a freshly-forked
# child a copy of an interpreter-level lock (e.g. the import lock) held by a
# thread that no longer exists in the child, wedging it forever on its very
# first import — which is exactly what `worker_init` does. `spawn` starts a
# clean interpreter instead, sidestepping that whole class of deadlock.
_MP_CONTEXT = multiprocessing.get_context("spawn")


class JobManager:
    def __init__(self, work_dir: str):
        self.work_dir = work_dir
        os.makedirs(work_dir, exist_ok=True)

        self._jobs = {}                       # job_id -> record dict
        self._order = []                      # job_ids still queued, in FIFO order
        self._lock = threading.Lock()
        self._queue = queue.Queue()           # job_ids waiting to be dispatched
        self._slots = threading.Semaphore(MAX_CONCURRENT)
        self._executor_lock = threading.Lock()  # guards swapping self._executor out
        self._executor = ProcessPoolExecutor(
            max_workers=MAX_CONCURRENT, initializer=analyze.worker_init, mp_context=_MP_CONTEXT
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

            with self._executor_lock:
                executor = self._executor
            try:
                future = executor.submit(
                    analyze.transcribe, rec["in_path"], rec["out_path"], rec["tempo"], rec["quantize"]
                )
            except BrokenProcessPool:
                # A previous job already killed the pool (e.g. the timeout
                # watchdog below fired for it). Replace it and fail this job
                # rather than submitting into a pool that will never run it.
                self._fail_job(job_id, "Could not transcribe that audio.")
                self._rebuild_executor(executor)
                continue

            # basic-pitch has been observed to wedge indefinitely on certain
            # malformed clips (no exception, no crash — the worker process
            # just never returns). ProcessPoolExecutor has no way to cancel a
            # task already in flight, so the only recovery is to notice via a
            # timeout and throw away the whole worker pool.
            timer = threading.Timer(JOB_TIMEOUT_SECONDS, self._on_timeout, args=(job_id, executor))
            timer.daemon = True
            with self._lock:
                rec["_timer"] = timer
            timer.start()
            future.add_done_callback(lambda f, jid=job_id: self._on_done(jid, f))

    def _on_timeout(self, job_id, executor):
        with self._lock:
            rec = self._jobs.get(job_id)
            still_processing = rec is not None and rec["status"] == "processing"
        if not still_processing:
            return  # finished naturally before the timeout fired
        self._fail_job(job_id, "Transcription timed out.")
        self._rebuild_executor(executor)

    def _fail_job(self, job_id, message):
        with self._lock:
            rec = self._jobs.get(job_id)
            if rec is None or rec["status"] != "processing":
                return
            rec["status"] = "error"
            rec["error"] = message
            rec["note_count"] = None
            rec["finished_at"] = time.time()
            in_path = rec["in_path"]
        _silent_unlink(in_path)
        self._slots.release()

    def _on_done(self, job_id, future):
        with self._lock:
            rec = self._jobs.get(job_id)
            if rec is None or rec["status"] != "processing":
                return  # already handled by the timeout watchdog, or swept away
            timer = rec.pop("_timer", None)
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
        if timer:
            timer.cancel()
        _silent_unlink(in_path)
        self._slots.release()

    def _rebuild_executor(self, broken_executor):
        """Replace a wedged/broken worker pool. Only ever swaps out the exact
        executor instance that was known bad, so two near-simultaneous
        failures don't rebuild twice."""
        with self._executor_lock:
            if self._executor is not broken_executor:
                return  # someone else already rebuilt it
            self._executor = ProcessPoolExecutor(
                max_workers=MAX_CONCURRENT, initializer=analyze.worker_init, mp_context=_MP_CONTEXT
            )
        # Worker processes stuck in a native/JIT deadlock won't respond to a
        # polite shutdown, so terminate them directly. `_processes` is a
        # private attribute; there is no public API for killing a specific
        # in-flight worker, and this is the standard pragmatic workaround.
        for proc in list(getattr(broken_executor, "_processes", {}).values()):
            try:
                proc.terminate()
            except Exception:
                pass
        broken_executor.shutdown(wait=False, cancel_futures=True)
        threading.Thread(target=self._warm_pool, daemon=True).start()

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
