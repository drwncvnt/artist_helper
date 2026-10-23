FROM python:3.12-slim

# NUMBA_CACHE_DIR: pymatting JIT-compiles with numba, and the container
# filesystem is read-only at runtime, so its cache lives on the /tmp tmpfs.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    U2NET_HOME=/models \
    NUMBA_CACHE_DIR=/tmp/numba-cache

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/app ./app

RUN useradd --create-home --uid 1000 appuser \
    && mkdir -p /models \
    && chown -R appuser:appuser /models
USER appuser

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s \
    CMD curl -f http://localhost:8000/api/health || exit 1

# Single web process: the rembg session is a process-global cache (lru_cache),
# and MAX_CONCURRENT_JOBS gates actual inference concurrency inside it, so a
# second uvicorn worker would just duplicate the loaded model in memory for no
# benefit.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
