import os
import re
from typing import Optional, Dict, Any

from s3_wallet_store import generate_presigned_url, delete_object, is_configured

WALLET_POOL_DIR = os.environ.get("WALLET_POOL_DIR", "/data/wallets")
KEYSTORE_PREFIX = "wallets/keystore/"
PASSWORD_PREFIX = "wallets/password/"

# In-memory tracking of allocated wallet marker paths.
# Restarting the backend resets this; the database remains the source of truth
# for which wallet is assigned to a running instance.
_allocated: set = set()


def _ensure_pool_dir():
    os.makedirs(WALLET_POOL_DIR, exist_ok=True)


def _parse_address_from_filename(fname: str) -> Optional[str]:
    """Extract Ethereum address from filename like '0xABC...address'."""
    name = fname.replace(".address", "")
    if re.match(r"^0x[a-fA-F0-9]{40}$", name):
        return name.lower()
    return None


def _keystore_key_for_address(address: str) -> str:
    return f"{KEYSTORE_PREFIX}{address.lower()}.json"


def _password_key_for_address(address: str) -> str:
    return f"{PASSWORD_PREFIX}{address.lower()}.password"


def _list_marker_files(directory: str) -> list:
    """Return full paths to .address marker files in a directory."""
    markers = []
    if not os.path.isdir(directory):
        return markers
    for fname in sorted(os.listdir(directory)):
        if fname.endswith(".address"):
            fpath = os.path.join(directory, fname)
            if os.path.isfile(fpath):
                markers.append(fpath)
    return markers


def list_available_wallets() -> list:
    """Return list of available wallet marker files from local pool.

    Supports two layouts:
      - Flat:     WALLET_POOL_DIR/0x<address>.address
      - Subdirs:  WALLET_POOL_DIR/<subfolder>/0x<address>.address
    """
    _ensure_pool_dir()
    wallets = []

    # Flat layout
    wallets.extend(_list_marker_files(WALLET_POOL_DIR))

    # Subfolder layout (transcoding, ai-batch, lv2v, etc.)
    for entry in sorted(os.listdir(WALLET_POOL_DIR)):
        subdir = os.path.join(WALLET_POOL_DIR, entry)
        if os.path.isdir(subdir):
            wallets.extend(_list_marker_files(subdir))

    # Exclude currently allocated wallets
    return [w for w in wallets if w not in _allocated]


def acquire_wallet() -> Optional[Dict[str, Any]]:
    """Pick an available wallet marker. Returns None if pool empty."""
    available = list_available_wallets()
    for fpath in available:
        fname = os.path.basename(fpath)
        address = _parse_address_from_filename(fname)
        if address:
            _allocated.add(fpath)
            return {
                "address": address,
                "source_path": fpath,
                "s3_keystore_key": _keystore_key_for_address(address),
                "s3_password_key": _password_key_for_address(address),
            }
    return None


def release_wallet(wallet_source_path: str):
    """Release a wallet back to the available pool."""
    if wallet_source_path:
        _allocated.discard(wallet_source_path)


def get_or_create_wallet() -> Dict[str, Any]:
    """Get wallet from pool. Raises if pool is empty (no auto-generation)."""
    wallet = acquire_wallet()
    if wallet:
        return wallet
    raise RuntimeError(
        "Wallet pool is empty. Create marker files in "
        f"'{WALLET_POOL_DIR}' named '0x<address>.address' (can be blank). "
        "Sub-folders (e.g., transcoding/, ai-batch/, lv2v/) are supported. "
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
