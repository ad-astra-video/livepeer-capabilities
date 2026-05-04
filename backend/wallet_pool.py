import os
import re
from typing import Optional, Dict, Any

from s3_wallet_store import generate_presigned_url, delete_object, is_configured

WALLET_POOL_DIR = os.environ.get("WALLET_POOL_DIR", "/data/wallets")
KEYSTORE_PREFIX = "wallets/keystore/"
PASSWORD_PREFIX = "wallets/password/"


def _ensure_pool_dir():
    os.makedirs(WALLET_POOL_DIR, exist_ok=True)


def _parse_address_from_filename(fname: str) -> Optional[str]:
    """Extract Ethereum address from filename like '0xABC...json'."""
    name = fname.replace(".json", "").replace(".used", "")
    if re.match(r"^0x[a-fA-F0-9]{40}$", name):
        return name.lower()
    return None


def _keystore_key_for_address(address: str) -> str:
    return f"{KEYSTORE_PREFIX}{address.lower()}.json"


def _password_key_for_address(address: str) -> str:
    return f"{PASSWORD_PREFIX}{address.lower()}.password"


def list_available_wallets() -> list:
    """Return list of available wallet marker files from local pool."""
    _ensure_pool_dir()
    wallets = []
    for fname in sorted(os.listdir(WALLET_POOL_DIR)):
        if fname.endswith(".json") and not fname.endswith(".used.json"):
            fpath = os.path.join(WALLET_POOL_DIR, fname)
            wallets.append(fpath)
    return wallets


def acquire_wallet() -> Optional[Dict[str, Any]]:
    """Pick an available wallet marker and mark it used. Returns None if pool empty."""
    available = list_available_wallets()
    for fpath in available:
        fname = os.path.basename(fpath)
        address = _parse_address_from_filename(fname)
        if address:
            # Mark as used by renaming
            used_path = fpath.replace(".json", ".used.json")
            try:
                os.rename(fpath, used_path)
                return {
                    "address": address,
                    "source_path": used_path,
                    "s3_keystore_key": _keystore_key_for_address(address),
                    "s3_password_key": _password_key_for_address(address),
                }
            except Exception:
                continue
    return None


def release_wallet(wallet_source_path: str):
    """Delete the used marker file from pool."""
    if wallet_source_path and os.path.exists(wallet_source_path):
        try:
            os.remove(wallet_source_path)
        except Exception:
            pass


def get_or_create_wallet() -> Dict[str, Any]:
    """Get wallet from pool. Raises if pool is empty (no auto-generation)."""
    wallet = acquire_wallet()
    if wallet:
        return wallet
    raise RuntimeError(
        "Wallet pool is empty. Create marker files in "
        f"'{WALLET_POOL_DIR}' named '0x<address>.json' (can be blank). "
        "Upload keystore to S3 at 'wallets/keystore/0x<address>.json' and "
        "password to 'wallets/password/0x<address>.password'. "
        "See data/wallets/README.md for setup instructions."
    )


def prepare_wallet_for_instance(wallet: Dict[str, Any]) -> Dict[str, Any]:
    """
    Generate pre-signed URLs for both keystore and password.
    Returns enriched wallet dict with:
    - s3_keystore_url: pre-signed URL for the keystore JSON
    - s3_password_url: pre-signed URL for the password file
    """
    result = dict(wallet)
    keystore_key = wallet.get("s3_keystore_key")
    password_key = wallet.get("s3_password_key")
    if keystore_key:
        result["s3_keystore_url"] = generate_presigned_url(keystore_key)
    else:
        result["s3_keystore_url"] = None
    if password_key:
        result["s3_password_url"] = generate_presigned_url(password_key)
    else:
        result["s3_password_url"] = None
    return result


def cleanup_s3_wallet(s3_keystore_key: str, s3_password_key: str = None):
    """Delete wallet objects from S3."""
    if s3_keystore_key:
        delete_object(s3_keystore_key)
    if s3_password_key:
        delete_object(s3_password_key)
