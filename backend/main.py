import os
import json
from fastapi import FastAPI, Depends, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from fastapi import Response
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from datetime import datetime

from database import get_db, User, Region, Instance, CapabilityData, JobRun, SessionLocal, InstanceStatus
from auth import (
    get_current_user, init_admin_user, hash_password,
    verify_password, create_token, decode_token
)
from vultr_client import vultr, VultrAPIError
from wallet_pool import (
    get_or_create_wallet, release_wallet, prepare_wallet_for_instance,
    cleanup_s3_wallet, list_available_wallets, create_wallet_marker, WALLET_POOL_DIR
)
import uuid
import httpx

app = FastAPI(title="Livepeer Capabilities Admin API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

WORKER_TOKEN = os.environ.get("WORKER_API_TOKEN", "worker-secret")

async def wipe_instance_wallet(ip_address: str, instance_token: str) -> bool:
    """Send wipe command to instance cleanup daemon. Returns True if wiped or unreachable."""
    if not ip_address:
        return True
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"http://{ip_address}:9999/wipe",
                json={"token": instance_token},
                timeout=10.0
            )
            return resp.status_code == 200
    except Exception:
        return True

@app.on_event("startup")
def startup():
    import sqlite3
    db_path = os.environ.get("DATABASE_PATH", "/data/admin.db")
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("PRAGMA table_info(users)")
    columns = [col[1] for col in cursor.fetchall()]
    if "token_version" not in columns:
        cursor.execute("ALTER TABLE users ADD COLUMN token_version INTEGER DEFAULT 0")
        conn.commit()
        print("Migrated: added token_version column to users")
    conn.close()
    db = next(get_db())
    init_admin_user(db)

    available = list_available_wallets()
    if not available:
        print("WARNING: No wallet markers found. Gateway instances will fail to spawn. "
              "Create .address marker files in the wallet pool directory.")

# ─── Auth Routes ───
class LoginRequest(BaseModel):
    username: str
    password: str

@app.post("/api/auth/login")
def login(req: LoginRequest, response: Response, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == req.username).first()
    if not user or not verify_password(req.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token = create_token(user.username, user.token_version)
    response.set_cookie(
        key="session",
        value=token,
        httponly=True,
        secure=False,
        samesite="lax",
        max_age=60 * 60 * 24 * 7
    )
    return {"user": {"username": user.username, "role": user.role}}

@app.get("/api/auth/me")
def me(user: User = Depends(get_current_user)):
    return {"username": user.username, "role": user.role}

@app.post("/api/auth/logout")
def logout(response: Response):
    response.delete_cookie(key="session")
    return {"ok": True}

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str

@app.post("/api/auth/change-password")
def change_password(req: ChangePasswordRequest, response: Response, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if not verify_password(req.current_password, user.password_hash):
        raise HTTPException(status_code=401, detail="Current password is incorrect")
    if len(req.new_password) < 6:
        raise HTTPException(status_code=400, detail="New password must be at least 6 characters")
    user.password_hash = hash_password(req.new_password)
    user.token_version += 1
    db.commit()
    db.refresh(user)
    token = create_token(user.username, user.token_version)
    response.set_cookie(
        key="session",
        value=token,
        httponly=True,
        secure=False,
        samesite="lax",
        max_age=60 * 60 * 24 * 7
    )
    return {"ok": True, "message": "Password updated successfully"}

# ─── Region Routes ───
class RegionCreate(BaseModel):
    vultr_region_id: str
    name: str
    city: str
    country: str
    continent: str

@app.get("/api/regions")
def list_regions(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return db.query(Region).all()

@app.post("/api/regions")
def create_region(req: RegionCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    region = Region(**req.dict())
    db.add(region)
    db.commit()
    db.refresh(region)
    return region

@app.delete("/api/regions/{region_id}")
def delete_region(region_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    region = db.query(Region).filter(Region.id == region_id).first()
    if not region:
        raise HTTPException(status_code=404, detail="Region not found")
    db.delete(region)
    db.commit()
    return {"ok": True}

# ─── Vultr Region Discovery ───
@app.get("/api/vultr/regions")
async def vultr_regions(user: User = Depends(get_current_user)):
    try:
        regions = await vultr.list_regions()
        return [{"id": r["id"], "city": r["city"], "country": r["country"], "continent": r["continent"]} for r in regions]
    except VultrAPIError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ─── Instance Routes ───
@app.get("/api/instances")
def list_instances(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return db.query(Instance).all()

@app.post("/api/instances")
async def create_instance(req: dict, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    region_id = req.get("region_id")
    label = req.get("label", f"lp-worker-{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}")
    instance_uuid = str(uuid.uuid4())[:8]
    wallet = None
    wallet_source = None
    try:
        wallet = get_or_create_wallet()
        prepared = prepare_wallet_for_instance(wallet)
        wallet_source = wallet.get("source_path")

        vultr_instance = await vultr.create_instance(
            region_id, label, instance_uuid,
            s3_keystore_url=prepared.get("s3_keystore_url", ""),
            s3_password_url=prepared.get("s3_password_url", "")
        )
        instance = Instance(
            vultr_instance_id=vultr_instance.get("id"),
            instance_uuid=instance_uuid,
            region_id=region_id,
            label=label,
            ip_address=vultr_instance.get("main_ip", ""),
            status="installing",
            wallet_address=prepared["address"],
            s3_keystore_key=prepared.get("s3_keystore_key"),
            s3_password_key=prepared.get("s3_password_key")
        )
        db.add(instance)

        job = JobRun(
            region_id=region_id,
            instance_id=instance_uuid,
            status="running"
        )
        db.add(job)
        db.commit()
        db.refresh(instance)
        return instance
    except VultrAPIError as e:
        if wallet_source:
            release_wallet(wallet_source)
        if wallet:
            cleanup_s3_wallet(
                wallet.get("s3_keystore_key"),
                wallet.get("s3_password_key")
            )
        raise HTTPException(status_code=e.status_code, detail=str(e))
    except Exception as e:
        if wallet_source:
            release_wallet(wallet_source)
        if wallet:
            cleanup_s3_wallet(
                wallet.get("s3_keystore_key"),
                wallet.get("s3_password_key")
            )
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/api/instances/{instance_id}")
async def delete_instance(instance_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    instance = db.query(Instance).filter(Instance.vultr_instance_id == instance_id).first()
    if not instance:
        raise HTTPException(status_code=404, detail="Instance not found")
    try:
        await wipe_instance_wallet(instance.ip_address, WORKER_TOKEN)
    except Exception:
        pass
    try:
        await vultr.delete_instance(instance_id)
    except Exception:
        pass
    cleanup_s3_wallet(instance.s3_keystore_key, instance.s3_password_key)
    db.delete(instance)
    db.commit()
    return {"ok": True}

@app.post("/api/instances/{instance_id}/wallet-downloaded")
def wallet_downloaded(instance_id: str, req: dict, db: Session = Depends(get_db)):
    """Called by instance after successfully downloading wallet from S3."""
    if req.get("worker_token") != WORKER_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid worker token")
    instance = db.query(Instance).filter(Instance.instance_uuid == instance_id).first()
    if instance:
        cleanup_s3_wallet(instance.s3_keystore_key, instance.s3_password_key)
        instance.s3_keystore_key = None
        instance.s3_password_key = None
        db.commit()
    return {"ok": True}


@app.post("/api/instances/{instance_id}/status")
def update_instance_status(instance_id: str, req: dict, db: Session = Depends(get_db)):
    """Receive status updates from worker instances during install/runtime."""
    if req.get("worker_token") != WORKER_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid worker token")
    instance = db.query(Instance).filter(Instance.instance_uuid == instance_id).first()
    if instance:
        status = InstanceStatus(
            instance_id=instance.vultr_instance_id,
            component=req.get("component", "unknown"),
            status=req.get("status", "unknown"),
            message=req.get("message")
        )
        db.add(status)
        instance.last_seen_at = datetime.utcnow()
        db.commit()
    else:
        # Store with the provided ID even if instance not found (for debugging)
        status = InstanceStatus(
            instance_id=instance_id,
            component=req.get("component", "unknown"),
            status=req.get("status", "unknown"),
            message=req.get("message")
        )
        db.add(status)
        db.commit()
    return {"ok": True}

@app.get("/api/instances/{instance_id}/status")
def get_instance_status(instance_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """Get all status updates for an instance, newest first."""
    instance = db.query(Instance).filter(Instance.vultr_instance_id == instance_id).first()
    if not instance:
        raise HTTPException(status_code=404, detail="Instance not found")
    statuses = db.query(InstanceStatus).filter(InstanceStatus.instance_id == instance_id).order_by(InstanceStatus.created_at.desc()).all()
    return {
        "instance_id": instance_id,
        "statuses": [
            {
                "component": s.component,
                "status": s.status,
                "message": s.message,
                "created_at": s.created_at.isoformat() if s.created_at else None
            }
            for s in statuses
        ]
    }

@app.post("/api/instances/sync")
async def sync_instances(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    try:
        vultr_instances = await vultr.list_instances()
        existing = {i.vultr_instance_id: i for i in db.query(Instance).all()}
        for vi in vultr_instances:
            vid = vi.get("id")
            if vid in existing:
                existing[vid].status = vi.get("status", "unknown")
                existing[vid].ip_address = vi.get("main_ip", "")
                existing[vid].region_id = vi.get("region", "")
            else:
                instance = Instance(
                    vultr_instance_id=vid,
                    region_id=vi.get("region", ""),
                    label=vi.get("label", ""),
                    ip_address=vi.get("main_ip", ""),
                    status=vi.get("status", "unknown")
                )
                db.add(instance)
        db.commit()
        return {"ok": True, "count": len(vultr_instances)}
    except VultrAPIError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ─── Wallet Management ───
class WalletCreate(BaseModel):
    address: str
    subfolder: Optional[str] = None

@app.get("/api/wallets")
def list_wallets(user: User = Depends(get_current_user)):
    """List all wallet marker files in the pool."""
    wallets = []
    for fpath in list_available_wallets():
        fname = os.path.basename(fpath)
        dir_name = os.path.basename(os.path.dirname(fpath))
        subfolder = dir_name if dir_name != os.path.basename(WALLET_POOL_DIR) else None
        address = fname.replace(".address", "")
        wallets.append({"address": address, "path": fpath, "subfolder": subfolder})
    return {"wallets": wallets}

@app.post("/api/wallets")
def add_wallet(req: WalletCreate, user: User = Depends(get_current_user)):
    """Create a new wallet marker file."""
    try:
        fpath = create_wallet_marker(req.address, req.subfolder)
        return {"ok": True, "path": fpath, "address": req.address.strip().lower()}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ─── Capability Data (Worker-facing) ───
class CapabilitySubmit(BaseModel):
    worker_token: str
    instance_id: str
    region_id: str
    gateway_type: str
    data: Dict[str, Any]

@app.post("/api/capabilities")
def submit_capabilities(req: CapabilitySubmit, db: Session = Depends(get_db)):
    if req.worker_token != WORKER_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid worker token")
    cap = CapabilityData(
        instance_id=req.instance_id,
        region_id=req.region_id,
        gateway_type=req.gateway_type,
        data=req.data
    )
    db.add(cap)
    instance = db.query(Instance).filter(Instance.instance_uuid == req.instance_id).first()
    if instance:
        instance.last_seen_at = datetime.utcnow()
    db.commit()
    return {"ok": True}

# ─── Capability Data (Webapp-facing) ───
@app.get("/api/capabilities")
def get_capabilities(
    gateway_type: Optional[str] = None,
    db: Session = Depends(get_db)
):
    query = db.query(CapabilityData)
    if gateway_type:
        query = query.filter(CapabilityData.gateway_type == gateway_type)
    results = query.order_by(CapabilityData.received_at.desc()).all()
    seen = set()
    latest = []
    for r in results:
        key = (r.instance_id, r.gateway_type)
        if key not in seen:
            seen.add(key)
            latest.append({
                "instance_id": r.instance_id,
                "region_id": r.region_id,
                "gateway_type": r.gateway_type,
                "data": r.data,
                "received_at": r.received_at.isoformat() if r.received_at else None
            })
    return {"capabilities": latest}

@app.get("/api/capabilities/aggregated")
def get_aggregated_capabilities(db: Session = Depends(get_db)):
    query = db.query(CapabilityData).order_by(CapabilityData.received_at.desc())
    results = query.all()
    seen = set()
    aggregated = {}
    for r in results:
        key = (r.instance_id, r.gateway_type)
        if key in seen:
            continue
        seen.add(key)
        gt = r.gateway_type
        if gt not in aggregated:
            aggregated[gt] = {
                "gateway_type": gt,
                "regions": {},
                "orchestrators": [],
                "capabilities_names": {}
            }
        data = r.data or {}
        orchs = data.get("orchestrators") or []
        aggregated[gt]["orchestrators"].extend(orchs)
        aggregated[gt]["capabilities_names"].update(data.get("capabilities_names", {}))
        if r.region_id:
            aggregated[gt]["regions"][r.region_id] = {
                "instance_id": r.instance_id,
                "orch_count": len(orchs),
                "last_seen": r.received_at.isoformat() if r.received_at else None
            }
    return {"gateways": list(aggregated.values())}

# ─── Instance Completion (Worker-facing) ───
@app.post("/api/instances/{instance_id}/complete")
def complete_instance(instance_id: str, req: dict, db: Session = Depends(get_db)):
    if req.get("worker_token") != WORKER_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid worker token")
    job = db.query(JobRun).filter(JobRun.instance_id == instance_id).first()
    if job:
        job.status = "completed"
        job.completed_at = datetime.utcnow()
    instance = db.query(Instance).filter(Instance.instance_uuid == instance_id).first()
    if instance:
        instance.status = "completed"
    db.commit()
    return {"ok": True}

# ─── Scheduled Jobs ───
from apscheduler.schedulers.background import BackgroundScheduler

scheduler = BackgroundScheduler()

async def spawn_region_workers():
    db = SessionLocal()
    try:
        regions = db.query(Region).filter(Region.enabled == 1).all()
        for region in regions:
            label = f"lp-worker-{region.vultr_region_id}-{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}"
            instance_uuid = str(uuid.uuid4())[:8]
            wallet = None
            wallet_source = None
            try:
                wallet = get_or_create_wallet()
                prepared = prepare_wallet_for_instance(wallet)
                wallet_source = wallet.get("source_path")

                vultr_instance = await vultr.create_instance(
                    region.vultr_region_id, label, instance_uuid,
                    s3_keystore_url=prepared.get("s3_keystore_url", ""),
                    s3_password_url=prepared.get("s3_password_url", "")
                )
                instance = Instance(
                    vultr_instance_id=vultr_instance.get("id"),
                    instance_uuid=instance_uuid,
                    region_id=region.vultr_region_id,
                    label=label,
                    ip_address=vultr_instance.get("main_ip", ""),
                    status="installing",
                    wallet_address=prepared["address"],
                    s3_keystore_key=prepared.get("s3_keystore_key"),
                    s3_password_key=prepared.get("s3_password_key")
                )
                db.add(instance)
                job = JobRun(
                    region_id=region.vultr_region_id,
                    instance_id=instance_uuid,
                    status="running"
                )
                db.add(job)
                db.commit()
            except VultrAPIError as e:
                print(f"Vultr API error spawning in {region.vultr_region_id}: {e}")
                if wallet_source:
                    release_wallet(wallet_source)
                if wallet:
                    cleanup_s3_wallet(
                        wallet.get("s3_keystore_key"),
                        wallet.get("s3_password_key")
                    )
                db.rollback()
            except Exception as e:
                print(f"Failed to spawn worker in {region.vultr_region_id}: {e}")
                if wallet_source:
                    release_wallet(wallet_source)
                if wallet:
                    cleanup_s3_wallet(
                        wallet.get("s3_keystore_key"),
                        wallet.get("s3_password_key")
                    )
                db.rollback()
    finally:
        db.close()

def spawn_job():
    import asyncio
    asyncio.run(spawn_region_workers())

scheduler.add_job(spawn_job, 'interval', minutes=15, id='spawn_workers', replace_existing=True)
scheduler.start()

@app.get("/api/jobs")
def list_jobs(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return db.query(JobRun).order_by(JobRun.started_at.desc()).limit(50).all()

@app.post("/api/jobs/trigger")
def trigger_jobs(user: User = Depends(get_current_user)):
    spawn_job()
    return {"ok": True, "message": "Worker spawn triggered"}

# ─── Health ───
@app.get("/api/health")
def health():
    return {"status": "ok"}


# ─── Static Webapp (SPA catch-all) ───
STATIC_DIR = "/app/static"

@app.get("/static/agent.py")
def serve_agent():
    return FileResponse("/app/agent.py")



@app.get("/{full_path:path}")
async def serve_spa(full_path: str):
    if full_path.startswith("api/"):
        raise HTTPException(status_code=404)
    file_path = os.path.join(STATIC_DIR, full_path)
    if os.path.isfile(file_path):
        return FileResponse(file_path)
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))
