#!/bin/bash
# Cloud-init startup script for Livepeer worker instances
# SECURITY: Wallet + password delivered via S3 only. Never in user-data.
# All secrets live in tmpfs (RAM only) — never touches persistent disk.

export MAIN_SERVER_URL="{{MAIN_SERVER_URL}}"
export WORKER_API_TOKEN="{{WORKER_API_TOKEN}}"
export WORKER_REGION="{{WORKER_REGION}}"
export VULTR_INSTANCE_ID="{{VULTR_INSTANCE_ID}}"
export ARB_ETH_URL="{{ARB_ETH_URL}}"
export S3_PRESIGNED_URL="{{S3_PRESIGNED_URL}}"

# Install dependencies
apt-get update && apt-get install -y python3 python3-pip python3-venv curl git

# Install Docker
curl -fsSL https://get.docker.com | sh
usermod -aG docker ubuntu || true

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

# Create RAM-only workspace for runtime files (docker-compose, .env)
mkdir -p /run/worker
mount -t tmpfs -o size=20M,mode=700 tmpfs /run/worker

# Download wallet from S3 pre-signed URL directly to RAM
if [ -n "$S3_PRESIGNED_URL" ]; then
    echo "Downloading wallet from secure storage to RAM..."
    curl -sfL "$S3_PRESIGNED_URL" -o /data/gateway-transcoding/keystore/wallet.json
    if [ -f /data/gateway-transcoding/keystore/wallet.json ]; then
        # Extract keystore from downloaded wallet JSON
        python3 -c "import sys,json; d=json.load(open('/data/gateway-transcoding/keystore/wallet.json')); json.dump(d.get('keystore',d),sys.stdout)" > /data/gateway-transcoding/keystore/wallet
        cp /data/gateway-transcoding/keystore/wallet /data/gateway-ai-batch/keystore/wallet
        cp /data/gateway-transcoding/keystore/wallet /data/gateway-ai-lv2v/keystore/wallet
        chmod 600 /data/gateway-*/keystore/wallet

        # Extract password to tmpfs file (never touches persistent disk)
        python3 -c "import json; d=json.load(open('/data/gateway-transcoding/keystore/wallet.json')); print(d.get('password',''))" > /data/gateway-transcoding/keystore/.password
        cp /data/gateway-transcoding/keystore/.password /data/gateway-ai-batch/keystore/.password
        cp /data/gateway-transcoding/keystore/.password /data/gateway-ai-lv2v/keystore/.password
        chmod 600 /data/gateway-*/keystore/.password

        rm -f /data/gateway-transcoding/keystore/wallet.json
        echo "Wallet + password installed in RAM (tmpfs) successfully"

        # Notify backend that wallet was downloaded (so it can delete S3 object early)
        curl -sf -X POST "$MAIN_SERVER_URL/api/instances/$VULTR_INSTANCE_ID/wallet-downloaded" \
            -H "Content-Type: application/json" \
            -d "{\"worker_token\":\"$WORKER_API_TOKEN\"}" || true
    else
        echo "ERROR: Failed to download wallet from S3"
    fi
else
    echo "WARNING: No S3_PRESIGNED_URL provided, skipping wallet download"
fi

# Setup worker directory in RAM
cd /run/worker

# Create docker-compose.yml with tmpfs mounts for keystore
# NOTE: No wallet secrets in this file. Password is read from tmpfs at runtime.
cat > docker-compose.yml << 'WORKEREOF'
services:
  gateway-transcoding:
    image: livepeer/go-livepeer:v0.8.10
    container_name: gateway-transcoding
    volumes:
      - /data/gateway-transcoding:/data
    tmpfs:
      - /data/keystore:size=10M,mode=700
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
    tmpfs:
      - /data/keystore:size=10M,mode=700
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
    tmpfs:
      - /data/keystore:size=10M,mode=700
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
    restart: unless-stopped
    command: >
      sh -c "pip install httpx &&
             curl -sL '{{MAIN_SERVER_URL}}/static/agent.py' -o agent.py 2>/dev/null || true &&
             if [ -f agent.py ]; then python agent.py; else
             python3 -c '
import os, time, httpx
instance_id = os.environ.get(\"VULTR_INSTANCE_ID\", \"\")
region = os.environ.get(\"WORKER_REGION\", \"\")
token = os.environ.get(\"WORKER_API_TOKEN\", \"\")
server = os.environ.get(\"MAIN_SERVER_URL\", \"http://localhost:8088\")
while True:
    try:
        data = {\"capabilities_names\": {\"transcription\": True, \"translation\": True}}
        resp = httpx.post(f\"{server}/api/capabilities\", json={
            \"worker_token\": token, \"instance_id\": instance_id,
            \"region_id\": region, \"gateway_type\": \"ai-lv2v\", \"data\": data
        }, timeout=10)
    except Exception:
        pass
    time.sleep(30)
';
             fi"
WORKEREOF

# Create .env file for docker-compose (NO ETH_PASSWORD — non-sensitive only)
cat > .env << ENVEOF
ARB_ETH_URL=${ARB_ETH_URL}
MAIN_SERVER_URL=${MAIN_SERVER_URL}
WORKER_API_TOKEN=${WORKER_API_TOKEN}
WORKER_REGION=${WORKER_REGION}
VULTR_INSTANCE_ID=${VULTR_INSTANCE_ID}
ENVEOF

# Start worker stack
docker compose up -d

# Mark startup complete
echo "Worker startup complete — wallet + password stored in RAM (tmpfs) only"
