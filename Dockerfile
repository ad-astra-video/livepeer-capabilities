# ─── Stage 1: Build webapp ───
FROM node:20-alpine AS webapp-build

WORKDIR /build

COPY webapp/package.json webapp/package-lock.json ./
RUN npm ci

COPY webapp/ ./
RUN npm run build

# ─── Stage 2: Backend ───
FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./
COPY worker/agent.py /app/agent.py
COPY --from=webapp-build /build/dist /app/static

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
