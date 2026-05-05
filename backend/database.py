import os
from sqlalchemy import create_engine, Column, Integer, String, DateTime, Text, JSON
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from datetime import datetime

DB_PATH = os.environ.get("DATABASE_PATH", "/data/admin.db")
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

engine = create_engine(f"sqlite:///{DB_PATH}", connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True)
    password_hash = Column(String)
    role = Column(String, default="admin")
    token_version = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)

class Region(Base):
    __tablename__ = "regions"
    id = Column(Integer, primary_key=True, index=True)
    vultr_region_id = Column(String, unique=True, index=True)
    name = Column(String)
    city = Column(String)
    country = Column(String)
    continent = Column(String)
    enabled = Column(Integer, default=1)
    created_at = Column(DateTime, default=datetime.utcnow)

class Instance(Base):
    __tablename__ = "instances"
    id = Column(Integer, primary_key=True, index=True)
    vultr_instance_id = Column(String, unique=True, index=True)
    instance_uuid = Column(String, index=True, nullable=True)
    region_id = Column(String)
    label = Column(String)
    ip_address = Column(String)
    status = Column(String, default="pending")
    wallet_address = Column(String, nullable=True)
    eth_password = Column(String, nullable=True)
    s3_keystore_key = Column(String, nullable=True)
    s3_password_key = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    last_seen_at = Column(DateTime, nullable=True)

class CapabilityData(Base):
    __tablename__ = "capability_data"
    id = Column(Integer, primary_key=True, index=True)
    instance_id = Column(String, index=True)
    region_id = Column(String, index=True)
    gateway_type = Column(String, index=True)
    data = Column(JSON)
    received_at = Column(DateTime, default=datetime.utcnow)

class JobRun(Base):
    __tablename__ = "job_runs"
    id = Column(Integer, primary_key=True, index=True)
    region_id = Column(String, index=True)
    instance_id = Column(String, index=True)
    status = Column(String, default="pending")
    started_at = Column(DateTime, default=datetime.utcnow)
    completed_at = Column(DateTime, nullable=True)
    orch_count = Column(Integer, nullable=True)


class InstanceStatus(Base):
    __tablename__ = "instance_status"
    id = Column(Integer, primary_key=True, index=True)
    instance_id = Column(String, index=True)
    component = Column(String)
    status = Column(String)
    message = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

class WorkerLog(Base):
    __tablename__ = "worker_logs"
    id = Column(Integer, primary_key=True, index=True)
    instance_id = Column(String, index=True)
    log_text = Column(Text)
    created_at = Column(DateTime, default=datetime.utcnow)

Base.metadata.create_all(bind=engine)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
