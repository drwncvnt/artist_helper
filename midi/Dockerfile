FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py index.html ./

EXPOSE 11000
# Behind the gateway; not exposed publicly.
CMD ["gunicorn", "--bind", "0.0.0.0:11000", "--workers", "2", "app:app"]
