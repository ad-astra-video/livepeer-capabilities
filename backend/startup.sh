#!/bin/bash
# Cloud-init startup script for Livepeer worker instances
# SECURITY: Keystore + password delivered via separate S3 URLs. Never in user-data.
# All secrets live in tmpfs (RAM only) — never touches persistent disk.
#
# Flow:
#   1. Create tmpfs + download wallet from S3
#   2. If download fails -> self-destruct in 5 min
#   3. If OK -> proceed with apt, docker, compose

export MAIN_SERVER_URL="{{MAIN_SERVER_URL}}"
export WORKER_API_TOKEN="{{WORKER_API_TOKEN}}"
export WORKER_REGION="{{WORKER_REGION}}"
export VULTR_INSTANCE_ID="{{VULTR_INSTANCE_ID}}"
export ARB_ETH_URL="{{ARB_ETH_URL}}"
export S3_KEYSTORE_URL="{{S3_KEYSTORE_URL}}"
export S3_PASSWORD_URL="{{S3_PASSWORD_URL}}"

# ─── Globals to hold last download error details ───
_LAST_HTTP_CODE=""
_LAST_CURL_EXIT=""
_LAST_CURL_ERROR=""

# Helper to report install status back to backend
report_status() {
    local component="$1"
    local status="$2"
    local message="${3:-}"
    message=$(printf '%s' "$message" | tr '\n\r' '  ' | sed 's/"/\\"/g')
    curl -sf -X POST "$MAIN_SERVER_URL/api/instances/$VULTR_INSTANCE_ID/status" \
        -H "Content-Type: application/json" \
        -d "{\"worker_token\":\"$WORKER_API_TOKEN\",\"component\":\"$component\",\"status\":\"$status\",\"message\":\"$message\"}" 2>/dev/null || true
}

report_status "startup" "started" "Cloud-init began"

# ─── Phase 1: Wallet download (MUST succeed before anything else) ───
# Create RAM-only tmpfs for wallet
mkdir -p /tmp/wallet
mount -t tmpfs -o size=10M,mode=700 tmpfs /tmp/wallet
report_status "wallet-tmpfs" "ok" "RAM-only wallet mount created"

# Download helper
download_s3_file() {
    local url="$1"
    local out_path="$2"
    local desc="$3"
    local err_file="/tmp/${desc}_curl_err.log"

    _LAST_HTTP_CODE=""
    _LAST_CURL_EXIT=""
    _LAST_CURL_ERROR=""

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

    _LAST_HTTP_CODE="${http_code:-unknown}"
    _LAST_CURL_EXIT="$curl_exit"
    if [ -s "$err_file" ]; then
        _LAST_CURL_ERROR=$(head -c 400 "$err_file" | tr '\n\r' '  ')
    fi

    if [ "$http_code" != "200" ]; then
        echo "  ERROR: ${desc} download failed (HTTP ${http_code})"
        echo "  URL: ${url}"
        if [ -s "$err_file" ]; then
            echo "  curl stderr:"
            cat "$err_file" | sed 's/^/    /'
        fi
        rm -f "$out_path"
        return 1
    fi

    if [ ! -s "$out_path" ]; then
        echo "  ERROR: ${desc} downloaded file is empty"
        _LAST_CURL_ERROR="Downloaded file is empty"
        return 1
    fi

    echo "  ${desc} downloaded successfully"
    return 0
}

# Check URLs exist
if [ -z "$S3_KEYSTORE_URL" ] || [ -z "$S3_PASSWORD_URL" ]; then
    echo "FATAL: S3_KEYSTORE_URL or S3_PASSWORD_URL not provided"
    report_status "wallet" "error" "No S3 URLs provided for wallet download"
    echo "Scheduling self-destruct in 5 minutes..."
    ( sleep 300; shutdown -h now "Wallet download failed: no S3 URLs" ) &
    exit 1
fi

# Download keystore
if ! download_s3_file "$S3_KEYSTORE_URL" /tmp/wallet/keystore "keystore"; then
    echo "FATAL: Keystore download failed"
    report_status "wallet" "error" "Keystore download failed (HTTP ${_LAST_HTTP_CODE:-unknown}, curl_exit ${_LAST_CURL_EXIT:-unknown}, URL=${S3_KEYSTORE_URL}) ${_LAST_CURL_ERROR}"
    echo "Scheduling self-destruct in 5 minutes..."
    ( sleep 300; shutdown -h now "Wallet download failed: keystore" ) &
    exit 1
fi

# Download password
if ! download_s3_file "$S3_PASSWORD_URL" /tmp/wallet/password "password"; then
    echo "FATAL: Password download failed"
    report_status "wallet" "error" "Password download failed (HTTP ${_LAST_HTTP_CODE:-unknown}, curl_exit ${_LAST_CURL_EXIT:-unknown}, URL=${S3_PASSWORD_URL}) ${_LAST_CURL_ERROR}"
    echo "Scheduling self-destruct in 5 minutes..."
    ( sleep 300; shutdown -h now "Wallet download failed: password" ) &
    exit 1
fi

chmod 600 /tmp/wallet/keystore /tmp/wallet/password
report_status "wallet" "downloaded" "Keystore ($(stat -c%s /tmp/wallet/keystore)B) + password ($(stat -c%s /tmp/wallet/password)B) in RAM"

# ─── Phase 2: Full setup (only reached if wallet download succeeded) ───

# Install dependencies
apt-get update && apt-get install -y python3 python3-pip python3-venv curl git
report_status "apt" "ok" "Dependencies installed"

# Install Docker
curl -fsSL https://get.docker.com | sh
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

mount -t tmpfs -o size=10M,mode=755 tmpfs /data/gateway-transcoding/keystore
mount -t tmpfs -o size=10M,mode=755 tmpfs /data/gateway-ai-batch/keystore
mount -t tmpfs -o size=10M,mode=755 tmpfs /data/gateway-ai-lv2v/keystore
report_status "tmpfs" "ok" "RAM-only keystore mounts created"

# Copy wallet from early tmpfs into gateway keystore dirs
cp /tmp/wallet/keystore /data/gateway-transcoding/keystore/wallet
cp /tmp/wallet/keystore /data/gateway-ai-batch/keystore/wallet
cp /tmp/wallet/keystore /data/gateway-ai-lv2v/keystore/wallet
cp /tmp/wallet/password /data/gateway-transcoding/keystore/.password
cp /tmp/wallet/password /data/gateway-ai-batch/keystore/.password
cp /tmp/wallet/password /data/gateway-ai-lv2v/keystore/.password
chmod 600 /data/gateway-*/keystore/wallet /data/gateway-*/keystore/.password

# Wipe early wallet tmpfs
rm -f /tmp/wallet/keystore /tmp/wallet/password
umount /tmp/wallet

# Create RAM-only workspace for runtime files (docker-compose, .env)
mkdir -p /run/worker
mount -t tmpfs -o size=20M,mode=755 tmpfs /run/worker

# Setup worker directory in RAM
cd /run/worker

# Write fallback agent script
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
      sh -c "curl -sL https://astral.sh/uv/install.sh | sh &&
             export PATH=\"/root/.local/bin:$PATH\" &&
             uv pip install --system httpx &&
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
