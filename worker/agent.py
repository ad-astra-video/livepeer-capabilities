import os
import sys
import time
import httpx
import json
import threading
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

# ─── Log buffer ───
_log_buffer = []
_log_lock = threading.Lock()
_last_flush_cycle = 0
LOG_FLUSH_INTERVAL = 5  # flush every N polling cycles

def log(msg):
    ts = datetime.utcnow().isoformat()
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    with _log_lock:
        _log_buffer.append(line)

def flush_logs():
    """Send buffered logs to the backend."""
    with _log_lock:
        if not _log_buffer:
            return
        text = "\n".join(_log_buffer)
        _log_buffer.clear()
    try:
        payload = {
            "worker_token": WORKER_API_TOKEN,
            "log_text": text
        }
        resp = httpx.post(
            f"{MAIN_SERVER_URL}/api/instances/{INSTANCE_ID}/logs",
            json=payload,
            timeout=10
        )
        if resp.status_code == 200:
            log(f"  -> LOG FLUSH: sent {len(text)} chars, HTTP {resp.status_code}")
        else:
            log(f"  -> LOG FLUSH: HTTP {resp.status_code} (logs remain buffered)")
    except Exception as e:
        log(f"  -> LOG FLUSH FAILED: {e} (logs remain buffered)")

def report_status(component, status, message=""):
    try:
        payload = {
            "worker_token": WORKER_API_TOKEN,
            "component": component,
            "status": status,
            "message": message
        }
        log(f"  -> REPORT [{component}] status={status} msg={message}")
        resp = httpx.post(
            f"{MAIN_SERVER_URL}/api/instances/{INSTANCE_ID}/status",
            json=payload,
            timeout=10
        )
        log(f"  -> REPORT OK: HTTP {resp.status_code}")
    except Exception as e:
        log(f"  -> REPORT FAILED: {e}")

def fetch_capabilities(gateway):
    name = gateway["name"]
    url = gateway["url"]
    log(f"  [FETCH] Polling {name} at {url}")
    try:
        resp = httpx.get(url, timeout=30)
        log(f"  [FETCH] {name} responded HTTP {resp.status_code}")
        resp.raise_for_status()
        data = resp.json()
        log(f"  [FETCH] {name} capabilities received: {json.dumps(data)[:200]}")
        return data
    except httpx.HTTPStatusError as e:
        log(f"  [FETCH] {name} HTTP error: {e.response.status_code} {e.response.text[:100]}")
        return None
    except httpx.ConnectError as e:
        log(f"  [FETCH] {name} connection refused: {e}")
        return None
    except httpx.TimeoutException as e:
        log(f"  [FETCH] {name} timed out after 30s")
        return None
    except Exception as e:
        log(f"  [FETCH] {name} unexpected error: {e}")
        return None

def submit_capabilities(gateway_type, data):
    log(f"  [SUBMIT] Posting {gateway_type} capabilities to {MAIN_SERVER_URL}/api/capabilities")
    try:
        payload = {
            "worker_token": WORKER_API_TOKEN,
            "instance_id": INSTANCE_ID,
            "region_id": WORKER_REGION,
            "gateway_type": gateway_type,
            "data": data
        }
        resp = httpx.post(f"{MAIN_SERVER_URL}/api/capabilities", json=payload, timeout=30)
        log(f"  [SUBMIT] {gateway_type} HTTP {resp.status_code}: {resp.text[:150]}")
        resp.raise_for_status()
        return True
    except httpx.HTTPStatusError as e:
        log(f"  [SUBMIT] {gateway_type} HTTP error: {e.response.status_code} {e.response.text[:100]}")
        return False
    except Exception as e:
        log(f"  [SUBMIT] {gateway_type} failed: {e}")
        return False

def mark_complete():
    log(f"  [COMPLETE] Calling {MAIN_SERVER_URL}/api/instances/{INSTANCE_ID}/complete")
    try:
        payload = {"worker_token": WORKER_API_TOKEN}
        resp = httpx.post(
            f"{MAIN_SERVER_URL}/api/instances/{INSTANCE_ID}/complete",
            json=payload,
            timeout=10
        )
        log(f"  [COMPLETE] HTTP {resp.status_code}: {resp.text[:150]}")
        resp.raise_for_status()
        report_status("agent", "complete", "All gateways reported data, agent exiting")
        return True
    except Exception as e:
        log(f"  [COMPLETE] failed: {e}")
        return False

def run_once(gateways_done):
    pending = [gw for gw in GATEWAYS if gw["name"] not in gateways_done]
    log(f"  [LOOP] {len(pending)} gateway(s) remaining: {', '.join(g['name'] for g in pending)}")
    for gw in pending:
        data = fetch_capabilities(gw)
        if data:
            ok = submit_capabilities(gw["name"], data)
            if ok:
                gateways_done.add(gw["name"])
                report_status(f"gateway-{gw['name']}", "ok", "Capabilities fetched and submitted")
            else:
                log(f"  [WARN] {gw['name']} fetch succeeded but submit failed — will retry next cycle")
        else:
            report_status(f"gateway-{gw['name']}", "pending", "Waiting for gateway to respond")

def main():
    log("=" * 60)
    log("Worker agent starting")
    log("=" * 60)
    log(f"  INSTANCE_ID  = {INSTANCE_ID}")
    log(f"  WORKER_REGION = {WORKER_REGION}")
    log(f"  MAIN_SERVER  = {MAIN_SERVER_URL}")
    log(f"  POLL_INTERVAL = {POLL_INTERVAL}s")
    log(f"  GATEWAYS     = {len(GATEWAYS)} (transcoding, ai-batch, ai-lv2v)")
    log("=" * 60)

    report_status("agent", "started", "Worker agent began polling")

    gateways_done = set()
    max_attempts = 60  # 60 * 30s = 30 minutes max runtime
    attempt = 0

    while attempt < max_attempts:
        attempt += 1
        remaining_time = (max_attempts - attempt + 1) * POLL_INTERVAL
        log(f"--- Attempt {attempt}/{max_attempts} (est {remaining_time}s remaining) ---")
        run_once(gateways_done)

        # Flush logs periodically
        if attempt % LOG_FLUSH_INTERVAL == 0:
            flush_logs()

        if len(gateways_done) == len(GATEWAYS):
            log(f"SUCCESS: All {len(GATEWAYS)} gateways completed after {attempt} attempts")
            # Final log flush before completing
            flush_logs()
            mark_complete()
            log("Agent exiting cleanly")
            sys.exit(0)

        done = len(gateways_done)
        log(f"  Progress: {done}/{len(GATEWAYS)} gateways done, sleeping {POLL_INTERVAL}s...")
        time.sleep(POLL_INTERVAL)

    log("TIMEOUT: Max attempts reached without completing all gateways")
    log(f"  Completed: {', '.join(sorted(gateways_done)) or 'none'}")
    log(f"  Missing:   {', '.join(sorted(gw['name'] for gw in GATEWAYS if gw['name'] not in gateways_done))}")
    # Final flush on timeout
    flush_logs()
    report_status("agent", "timeout", "Max polling attempts reached")
    log("Agent exiting with error code 1")
    sys.exit(1)

if __name__ == "__main__":
    main()
