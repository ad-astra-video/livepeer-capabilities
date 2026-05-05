import os
import sys
import time
import httpx
import json
from datetime import datetime

MAIN_SERVER_URL = os.environ.get("MAIN_SERVER_URL", "http://localhost:8088")
WORKER_API_TOKEN = os.environ.get("WORKER_API_TOKEN", "worker-secret")
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

def report_status(component, status, message=""):
    try:
        payload = {
            "worker_token": WORKER_API_TOKEN,
            "component": component,
            "status": status,
            "message": message
        }
        httpx.post(
            f"{MAIN_SERVER_URL}/api/instances/{INSTANCE_ID}/status",
            json=payload,
            timeout=10
        )
    except Exception as e:
        log(f"Failed to report status: {e}")

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
            "worker_token": WORKER_API_TOKEN,
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

def mark_complete():
    try:
        payload = {"worker_token": WORKER_API_TOKEN}
        resp = httpx.post(
            f"{MAIN_SERVER_URL}/api/instances/{INSTANCE_ID}/complete",
            json=payload,
            timeout=10
        )
        resp.raise_for_status()
        log("Marked instance as complete")
        report_status("agent", "complete", "All gateways reported data, agent exiting")
        return True
    except Exception as e:
        log(f"Error marking complete: {e}")
        return False

def run_once(gateways_done):
    for gw in GATEWAYS:
        if gw["name"] in gateways_done:
            continue
        data = fetch_capabilities(gw)
        if data:
            submit_capabilities(gw["name"], data)
            gateways_done.add(gw["name"])
            report_status(f"gateway-{gw['name']}", "ok", "Capabilities fetched and submitted")
        else:
            report_status(f"gateway-{gw['name']}", "pending", "Waiting for gateway to respond")

def main():
    log(f"Worker agent started - region: {WORKER_REGION}, instance: {INSTANCE_ID}")
    log(f"Main server: {MAIN_SERVER_URL}")
    report_status("agent", "started", "Worker agent began polling")

    gateways_done = set()
    max_attempts = 60  # 60 * 30s = 30 minutes max runtime
    attempt = 0

    while attempt < max_attempts:
        run_once(gateways_done)

        if len(gateways_done) == len(GATEWAYS):
            log("All gateways have returned data — marking complete and exiting")
            mark_complete()
            sys.exit(0)

        log(f"Progress: {len(gateways_done)}/{len(GATEWAYS)} gateways done")
        attempt += 1
        time.sleep(POLL_INTERVAL)

    log("Max attempts reached — exiting without completion")
    report_status("agent", "timeout", "Max polling attempts reached, not all gateways responded")
    sys.exit(1)

if __name__ == "__main__":
    main()
