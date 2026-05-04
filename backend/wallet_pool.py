import os
import re
import json
from typing import Optional, Dict, Any

from s3_wallet_store import (
    list_objects, generate_presigned_url, delete_object, is_configured, get_object
)

WALLET_PREFIX = "wallets/"


def _parse_address_from_key(object_key: str) -> Optional[str]:
    """Extract Ethereum address from S3 object key like 'wallets/0xABC...json'."""
    filename = os.path.basename(object_key)
    name = filename.replace(".json", "")
    if re.match(r"^0x[a-fA-F0-9]{40}$", name):
        return name.lower()
    return None


def list_available_wallets() -> list:
    """Return list of available wallet object keys from S3."""
    if not is_configured():
        return []
    return list_objects(prefix=WALLET_PREFIX)


def acquire_wallet() -> Optional[Dict[str, Any]]:
    """Pick an available wallet from S3 pool. Returns None if pool empty."""
    available = list_available_wallets()
    for object_key in available:
        address = _parse_address_from_key(object_key)
        if address:
            return {
                "address": address,
                "s3_object_key": object_key,
                "source_path": None
            }
    return None


def release_wallet(wallet_source_path: str):
    """No-op for S3-only pool (cleanup is done via cleanup_s3_wallet)."""
    pass


def get_or_create_wallet() -> Dict[str, Any]:
    """Get wallet from S3 pool. Raises if pool is empty."""
    wallet = acquire_wallet()
    if wallet:
        return wallet
    raise RuntimeError(
        "S3 wallet pool is empty. Upload wallet JSON files to S3 under the "
        f"'{WALLET_PREFIX}' prefix with filenames like '0x<address>.json'. "
        "See data/wallets/README.md for setup instructions."
    )


def prepare_wallet_for_instance(wallet: Dict[str, Any]) -> Dict[str, Any]:
    """
    Return enriched wallet dict with:
    - s3_object_key: the S3 object key
    - s3_presigned_url: the temporary download URL for the instance
    """
    result = dict(wallet)
    object_key = wallet.get("s3_object_key")
    if object_key:
        presigned_url = generate_presigned_url(object_key)
        result["s3_presigned_url"] = presigned_url
    else:
        result["s3_presigned_url"] = None
    return result


def cleanup_s3_wallet(s3_object_key: str):
    """Delete wallet object from S3."""
    if s3_object_key:
        delete_object(s3_object_key)
