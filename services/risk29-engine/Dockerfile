FROM python:3.12-slim

WORKDIR /app
COPY services/risk29-engine /app
RUN pip install --no-cache-dir .

ENV PORT=8000
EXPOSE 8000
CMD ["sh", "-c", "uvicorn risk29_engine.main:app --host 0.0.0.0 --port ${PORT}"]
