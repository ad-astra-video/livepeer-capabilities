import os
import json
import secrets
from typing import Optional, Dict, Any

from s3_wallet_store import upload_wallet, generate_presigned_url, delete_object, is_configured

WALLET_POOL_DIR = os.environ.get("WALLET_POOL_DIR", "/data/wallets")
WALLET_MASTER_KEY = os.environ.get("WALLET_MASTER_KEY", "")

# Initialize Fernet if master key is provided
try:
    from cryptography.fernet import Fernet
    _fernet = Fernet(WALLET_MASTER_KEY.encode()) if WALLET_MASTER_KEY else None
except ImportError:
    _fernet = None

def _ensure_pool_dir():
    os.makedirs(WALLET_POOL_DIR, exist_ok=True)

def _decrypt_file(fpath: str) -> bytes:
    """Decrypt file if Fernet is available, otherwise read raw bytes."""
    with open(fpath, "rb") as f:
        data = f.read()
    if _fernet:
        return _fernet.decrypt(data)
    return data

def list_available_wallets() -> list:
    """Return list of available wallet file paths."""
    _ensure_pool_dir()
    wallets = []
    for fname in sorted(os.listdir(WALLET_POOL_DIR)):
        if fname.endswith(".json") and not fname.endswith(".used.json"):
            fpath = os.path.join(WALLET_POOL_DIR, fname)
            wallets.append(fpath)
    return wallets

def load_wallet(fpath: str) -> Optional[Dict[str, Any]]:
    """Load a wallet from file. Returns dict with address, keystore, password.
    Supports plaintext JSON and Fernet-encrypted files (when WALLET_MASTER_KEY is set)."""
    try:
        raw = _decrypt_file(fpath)
        data = json.loads(raw.decode("utf-8"))
        if "keystore" in data and "address" in data:
            return {
                "address": data["address"],
                "keystore": json.dumps(data["keystore"]) if isinstance(data["keystore"], dict) else data["keystore"],
                "password": data.get("password", "")
            }
        # Also support geth keystore format directly (the JSON itself is the keystore)
        if "crypto" in data and "address" in data:
            return {
                "address": data["address"],
                "keystore": json.dumps(data),
                "password": data.get("password", "")
            }
    except Exception:
        pass
    return None

def acquire_wallet() -> Optional[Dict[str, Any]]:
    """Pick an available wallet from the pool and mark it used. Returns None if pool empty."""
    available = list_available_wallets()
    for fpath in available:
        wallet = load_wallet(fpath)
        if wallet:
            # Mark as used by renaming
            used_path = fpath.replace(".json", ".used.json")
            try:
                os.rename(fpath, used_path)
                wallet["source_path"] = used_path
                return wallet
            except Exception:
                continue
    return None

def release_wallet(wallet_source_path: str):
    """Delete the used wallet file from pool."""
    if wallet_source_path and os.path.exists(wallet_source_path):
        try:
            os.remove(wallet_source_path)
        except Exception:
            pass

def generate_wallet() -> Dict[str, Any]:
    """Generate a new Ethereum wallet. Requires eth-account."""
    try:
        from eth_account import Account
    except ImportError:
        raise RuntimeError("eth-account not installed; cannot generate wallets")
    password = secrets.token_urlsafe(32)
    acct = Account.create(secrets.token_hex(32))
    keystore = Account.encrypt(acct.key.hex(), password)
    return {
        "address": acct.address,
        "keystore": json.dumps(keystore),
        "password": password,
        "source_path": None
    }

def get_or_create_wallet() -> Dict[str, Any]:
    """Get wallet from pool, or generate a new one if pool is empty."""
    wallet = acquire_wallet()
    if wallet:
        return wallet
    return generate_wallet()

def prepare_wallet_for_instance(wallet: Dict[str, Any]) -> Dict[str, Any]:
    """
    Upload wallet to S3 (if configured) and return enriched wallet dict with:
    - s3_object_key: the S3 object key
    - s3_presigned_url: the temporary download URL for the instance
    """
    result = dict(wallet)
    if is_configured():
        wallet_data = {
            "address": wallet["address"],
            "keystore": json.loads(wallet["keystore"]) if isinstance(wallet["keystore"], str) else wallet["keystore"],
            "password": wallet["password"]
        }
        object_key = upload_wallet(wallet_data)
        presigned_url = generate_presigned_url(object_key)
        result["s3_object_key"] = object_key
        result["s3_presigned_url"] = presigned_url
    else:
        result["s3_object_key"] = None
        result["s3_presigned_url"] = None
    return result

def cleanup_s3_wallet(s3_object_key: str):
    """Delete wallet object from S3."""
    if s3_object_key:
        delete_object(s3_object_key)
