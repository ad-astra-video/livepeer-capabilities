FROM python:3.11-slim

WORKDIR /app

# Install uv for fast package management
COPY --from=ghcr.io/astral-sh/uv:0.6.1 /uv /usr/local/bin/uv
COPY --from=ghcr.io/astral-sh/uv:0.6.1 /uvx /usr/local/bin/uvx

COPY requirements.txt .
RUN uv pip install --system --no-cache-dir -r requirements.txt

COPY agent.py .

CMD ["python", "agent.py"]
