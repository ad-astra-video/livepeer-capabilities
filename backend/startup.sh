#!/bin/bash
# Cloud-init startup script for Livepeer worker instances
# SECURITY: Keystore + password delivered via separate S3 URLs. Never in user-data.
# All secrets live in tmpfs (RAM only) — never touches persistent disk.

export MAIN_SERVER_URL="{{MAIN_SERVER_URL}}"
export WORKER_API_TOKEN="{{WORKER_API_TOKEN}}"
export WORKER_REGION="{{WORKER_REGION}}"
export VULTR_INSTANCE_ID="{{VULTR_INSTANCE_ID}}"
export ARB_ETH_URL="{{ARB_ETH_URL}}"
export S3_KEYSTORE_URL="{{S3_KEYSTORE_URL}}"
export S3_PASSWORD_URL="{{S3_PASSWORD_URL}}"

# Helper to report install status back to backend
report_status() {
    local component="$1"
    local status="$2"
    local message="${3:-}"
    curl -sf -X POST "$MAIN_SERVER_URL/api/instances/$VULTR_INSTANCE_ID/status" \
        -H "Content-Type: application/json" \
        -d "{\"worker_token\":\"$WORKER_API_TOKEN\",\"component\":\"$component\",\"status\":\"$status\",\"message\":\"$message\"}" 2>/dev/null || true
}

report_status "startup" "started" "Cloud-init began"

# Install dependencies
apt-get update && apt-get install -y python3 python3-pip python3-venv curl git
report_status "apt" "ok" "Dependencies installed"

# Install Docker
curl -fsSL https://get.docker.com | sh
# Vultr images may use 'root' or another default user; only add 'ubuntu' if it exists
if id ubuntu &>/dev/null; then
    usermod -aG docker ubuntu
fi
report_status "docker" "ok" "Docker installed"

# Create persistent data directories (for gateway state, NOT wallet)
mkdir -p /data/gateway-transcoding
mkdir -p /data/gateway-ai-batch
mkdir -p /data/gateway-ai-lv2v

# Create tmpfs mounts for keystore (RAM-only, never touches disk)
mkdir -p /data/gateway-transcoding/keystore
mkdir -p /data/gateway-ai-batch/keystore
mkdir -p /data/gateway-ai-lv2v/keystore

mount -t tmpfs -o size=10M,mode=700 tmpfs /data/gateway-transcoding/keystore
mount -t tmpfs -o size=10M,mode=700 tmpfs /data/gateway-ai-batch/keystore
mount -t tmpfs -o size=10M,mode=700 tmpfs /data/gateway-ai-lv2v/keystore
report_status "tmpfs" "ok" "RAM-only keystore mounts created"

# Create RAM-only workspace for runtime files (docker-compose, .env)
mkdir -p /run/worker
mount -t tmpfs -o size=20M,mode=700 tmpfs /run/worker

# ─── Download keystore and password from S3 ───
download_s3_file() {
    local url="$1"
    local out_path="$2"
    local desc="$3"
    local err_file="/tmp/${desc}_curl_err.log"

    echo "Downloading ${desc}..."
    echo "  URL prefix: ${url:0:80}..."

    local http_code
    http_code=$(curl -sL --max-time 30 --retry 3 --retry-delay 2 \
        -w "%{http_code}" \
        -o "$out_path" \
        "$url" 2>"$err_file")

    local curl_exit=$?
    echo "  HTTP status: ${http_code:-unknown}"
    echo "  curl exit code: $curl_exit"
    echo "  Output file: $out_path"
    echo "  File size: $(stat -c%s "$out_path" 2>/dev/null || echo 0) bytes"

    if [ "$http_code" != "200" ]; then
        echo "  ERROR: ${desc} download failed (HTTP ${http_code})"
        if [ -s "$err_file" ]; then
            echo "  curl stderr:"
            cat "$err_file" | sed 's/^/    /'
        fi
        rm -f "$out_path"
        return 1
    fi

    if [ ! -s "$out_path" ]; then
        echo "  ERROR: ${desc} downloaded file is empty"
        return 1
    fi

    echo "  ${desc} downloaded successfully"
    return 0
}

if [ -n "$S3_KEYSTORE_URL" ] && [ -n "$S3_PASSWORD_URL" ]; then
    if download_s3_file "$S3_KEYSTORE_URL" /data/gateway-transcoding/keystore/wallet "keystore"; then
        cp /data/gateway-transcoding/keystore/wallet /data/gateway-ai-batch/keystore/wallet
        cp /data/gateway-transcoding/keystore/wallet /data/gateway-ai-lv2v/keystore/wallet
        chmod 600 /data/gateway-*/keystore/wallet
        report_status "wallet" "downloaded" "Keystore downloaded to RAM ($(stat -c%s /data/gateway-transcoding/keystore/wallet 2>/dev/null || echo 0) bytes)"
    else
        report_status "wallet" "error" "Failed to download keystore from S3"
    fi

    if download_s3_file "$S3_PASSWORD_URL" /data/gateway-transcoding/keystore/.password "password"; then
        cp /data/gateway-transcoding/keystore/.password /data/gateway-ai-batch/keystore/.password
        cp /data/gateway-transcoding/keystore/.password /data/gateway-ai-lv2v/keystore/.password
        chmod 600 /data/gateway-*/keystore/.password
        report_status "password" "downloaded" "Password downloaded to RAM"
    else
        report_status "password" "error" "Failed to download password from S3"
    fi

    # Notify backend that wallet was downloaded (so it can delete S3 objects early)
    if [ -f /data/gateway-transcoding/keystore/wallet ] && [ -f /data/gateway-transcoding/keystore/.password ]; then
        curl -sf -X POST "$MAIN_SERVER_URL/api/instances/$VULTR_INSTANCE_ID/wallet-downloaded" \
            -H "Content-Type: application/json" \
            -d "{\"worker_token\":\"$WORKER_API_TOKEN\"}" || true
    fi
else
    echo "WARNING: S3_KEYSTORE_URL or S3_PASSWORD_URL not provided, skipping wallet download"
    report_status "wallet" "skipped" "No S3 URLs provided"
fi

# Setup worker directory in RAM
cd /run/worker

# Write fallback agent script so we don't embed multi-line Python inside YAML
cat > /run/worker/fallback_agent.py << 'PYEOF'
import os, time, httpx
instance_id = os.environ.get("VULTR_INSTANCE_ID", "")
region = os.environ.get("WORKER_REGION", "")
token = os.environ.get("WORKER_API_TOKEN", "")
server = os.environ.get("MAIN_SERVER_URL", "http://localhost:8088")
while True:
    try:
        data = {"capabilities_names": {"transcription": True, "translation": True}}
        resp = httpx.post(f"{server}/api/capabilities", json={
            "worker_token": token, "instance_id": instance_id,
            "region_id": region, "gateway_type": "ai-lv2v", "data": data
        }, timeout=10)
    except Exception:
        pass
    time.sleep(30)
PYEOF

# Create docker-compose.yml
# NOTE: No wallet secrets in this file. Password is read from tmpfs at runtime.
# NOTE: Host tmpfs at /data/gateway-*/keystore is bind-mounted through; no container tmpfs needed.
cat > docker-compose.yml << 'WORKEREOF'
services:
  gateway-transcoding:
    image: livepeer/go-livepeer:v0.8.10
    container_name: gateway-transcoding
    volumes:
      - /data/gateway-transcoding:/data
    ports:
      - 5937:5937
      - 2937:2937
    command: [
      "-gateway",
      "-rtmpAddr=gateway-transcoding:1937",
      "-httpAddr=gateway-transcoding:5937",
      "-cliAddr=gateway-transcoding:2937",
      "-httpIngest=true",
      "-v=9",
      "-network=arbitrum-one-mainnet",
      "-blockPollingInterval=10",
      "-ethUrl={{ARB_ETH_URL}}",
      "-ethPassword=/data/keystore/.password",
      "-ethKeystorePath=/data/keystore",
      "-extraNodes=10",
      "-dataDir=/data",
      "-monitor"
    ]

  gateway-ai-batch:
    image: livepeer/go-livepeer:v0.8.10
    container_name: gateway-ai-batch
    volumes:
      - /data/gateway-ai-batch:/data
    ports:
      - 5938:5938
      - 2938:2938
    command: [
      "-gateway",
      "-aiServiceRegistry",
      "-rtmpAddr=gateway-ai-batch:1938",
      "-httpAddr=gateway-ai-batch:5938",
      "-cliAddr=gateway-ai-batch:2938",
      "-httpIngest=true",
      "-v=9",
      "-network=arbitrum-one-mainnet",
      "-blockPollingInterval=10",
      "-ethUrl={{ARB_ETH_URL}}",
      "-ethPassword=/data/keystore/.password",
      "-ethKeystorePath=/data/keystore",
      "-extraNodes=10",
      "-dataDir=/data",
      "-monitor"
    ]

  gateway-ai-lv2v:
    image: livepeer/go-livepeer:v0.8.10
    container_name: gateway-ai-lv2v
    volumes:
      - /data/gateway-ai-lv2v:/data
    ports:
      - 5939:5939
      - 2939:2939
    command: [
      "-gateway",
      "-rtmpAddr=gateway-ai-lv2v:1939",
      "-httpAddr=gateway-ai-lv2v:5939",
      "-cliAddr=gateway-ai-lv2v:2939",
      "-orchWebhookUrl=https://livepeer.github.io/livepeer-infra/ai-orchestrators-prod.json",
      "-httpIngest=true",
      "-v=9",
      "-network=arbitrum-one-mainnet",
      "-blockPollingInterval=10",
      "-ethUrl={{ARB_ETH_URL}}",
      "-ethPassword=/data/keystore/.password",
      "-ethKeystorePath=/data/keystore",
      "-extraNodes=10",
      "-dataDir=/data",
      "-monitor"
    ]

  worker-agent:
    image: python:3.11-slim
    container_name: worker-agent
    working_dir: /app
    volumes:
      - /run/worker:/app
    environment:
      - MAIN_SERVER_URL={{MAIN_SERVER_URL}}
      - WORKER_API_TOKEN={{WORKER_API_TOKEN}}
      - WORKER_REGION={{WORKER_REGION}}
      - VULTR_INSTANCE_ID={{VULTR_INSTANCE_ID}}
      - POLL_INTERVAL=30
    depends_on:
      - gateway-transcoding
      - gateway-ai-batch
      - gateway-ai-lv2v
    restart: "no"
    command: >
      sh -c "pip install httpx &&
             curl -sL '{{MAIN_SERVER_URL}}/static/agent.py' -o /app/agent.py 2>/dev/null || true &&
             if [ -f /app/agent.py ]; then python /app/agent.py; else python /app/fallback_agent.py; fi"
WORKEREOF

# Create .env file for docker-compose (NO wallet secrets — non-sensitive only)
cat > .env << ENVEOF
ARB_ETH_URL=${ARB_ETH_URL}
MAIN_SERVER_URL=${MAIN_SERVER_URL}
WORKER_API_TOKEN=${WORKER_API_TOKEN}
WORKER_REGION=${WORKER_REGION}
VULTR_INSTANCE_ID=${VULTR_INSTANCE_ID}
ENVEOF

# Start worker stack
docker compose up -d
report_status "compose" "started" "Docker compose stack started"

# Mark startup complete
report_status "startup" "complete" "Cloud-init finished, worker running"
echo "Worker startup complete — keystore + password stored in RAM (tmpfs) only"
