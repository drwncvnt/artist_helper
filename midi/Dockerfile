FROM python:3.11-slim

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py generator.py index.html ./
RUN useradd --create-home --uid 1000 appuser
USER appuser

EXPOSE 11000
# Behind the gateway; not exposed publicly.
CMD ["gunicorn", "--bind", "0.0.0.0:11000", "--workers", "2", "--no-control-socket", "app:app"]
