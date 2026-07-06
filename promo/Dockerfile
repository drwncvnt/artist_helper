FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py font.ttf ./

EXPOSE 5002
# Behind the gateway; not exposed publicly. gunicorn for a production-grade WSGI
# server instead of Flask's dev server.
CMD ["gunicorn", "--bind", "0.0.0.0:5002", "--workers", "2", "app:app"]
