FROM python:3.12-slim

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py font.ttf ./
RUN useradd --create-home --uid 1000 appuser
USER appuser

EXPOSE 5002
# Behind the gateway; not exposed publicly. gunicorn for a production-grade WSGI
# server instead of Flask's dev server.
# No control socket: the admin interface is not needed and the filesystem is
# read-only anyway.
CMD ["gunicorn", "--bind", "0.0.0.0:5002", "--workers", "2", "--timeout", "60", "--no-control-socket", "app:app"]
