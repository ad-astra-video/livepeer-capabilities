import os
import sys
import time
import httpx
import json
from datetime import datetime

MAIN_SERVER_URL = os.environ.get("MAIN_SERVER_URL", "http://localhost:8088")
WORKER_TOKEN = os.environ.get("WORKER_API_TOKEN", "worker-secret")
WORKER_REGION = os.environ.get("WORKER_REGION", "unknown")
INSTANCE_ID = os.environ.get("VULTR_INSTANCE_ID", "local")
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "30"))

GATEWAYS = [
    {"name": "transcoding", "url": "http://gateway-transcoding:2937/getNetworkCapabilities"},
    {"name": "ai-batch", "url": "http://gateway-ai-batch:2938/getNetworkCapabilities"},
    {"name": "ai-lv2v", "url": "http://gateway-ai-lv2v:2939/getNetworkCapabilities"},
]

def log(msg):
    print(f"[{datetime.utcnow().isoformat()}] {msg}", flush=True)

def fetch_capabilities(gateway):
    try:
        resp = httpx.get(gateway["url"], timeout=30)
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        log(f"Error fetching {gateway['name']}: {e}")
        return None

def submit_capabilities(gateway_type, data):
    try:
        payload = {
            "worker_token": WORKER_TOKEN,
            "instance_id": INSTANCE_ID,
            "region_id": WORKER_REGION,
            "gateway_type": gateway_type,
            "data": data
        }
        resp = httpx.post(f"{MAIN_SERVER_URL}/api/capabilities", json=payload, timeout=30)
        resp.raise_for_status()
        log(f"Submitted {gateway_type} capabilities")
        return True
    except Exception as e:
        log(f"Error submitting {gateway_type}: {e}")
        return False

def run_once():
    for gw in GATEWAYS:
        data = fetch_capabilities(gw)
        if data:
            submit_capabilities(gw["name"], data)

def main():
    log(f"Worker agent started - region: {WORKER_REGION}, instance: {INSTANCE_ID}")
    log(f"Main server: {MAIN_SERVER_URL}")
    while True:
        run_once()
        time.sleep(POLL_INTERVAL)

if __name__ == "__main__":
    main()
