import os
import re
from typing import Optional, Dict, Any

from s3_wallet_store import (
    list_objects, generate_presigned_url, delete_object, is_configured
)

KEYSTORE_PREFIX = "wallets/keystore/"
PASSWORD_PREFIX = "wallets/password/"


def _parse_address_from_key(object_key: str) -> Optional[str]:
    """Extract Ethereum address from S3 object key like 'wallets/keystore/0xABC...json'."""
    filename = os.path.basename(object_key)
    name = filename.replace(".json", "")
    if re.match(r"^0x[a-fA-F0-9]{40}$", name):
        return name.lower()
    return None


def _password_key_for_address(address: str) -> str:
    """Compute the S3 object key for the password file given an address."""
    return f"{PASSWORD_PREFIX}{address.lower()}.password"


def list_available_wallets() -> list:
    """Return list of available keystore object keys from S3."""
    if not is_configured():
        return []
    return list_objects(prefix=KEYSTORE_PREFIX)


def acquire_wallet() -> Optional[Dict[str, Any]]:
    """Pick an available wallet from S3 pool. Returns None if pool empty."""
    available = list_available_wallets()
    for keystore_key in available:
        address = _parse_address_from_key(keystore_key)
        if address:
            password_key = _password_key_for_address(address)
            return {
                "address": address,
                "s3_keystore_key": keystore_key,
                "s3_password_key": password_key,
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
        "S3 wallet pool is empty. Upload keystore + password files to S3: "
        f"'{KEYSTORE_PREFIX}0x<address>.json' and "
        f"'{PASSWORD_PREFIX}0x<address>.password'. "
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
