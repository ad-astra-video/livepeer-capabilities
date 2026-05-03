#!/usr/bin/env python3
"""
Helper script to upload existing wallet JSON files to S3 for secure instance delivery.

Usage:
    python upload_to_s3.py /path/to/wallet.json

The wallet file should contain:
    {"address": "0x...", "keystore": {...}, "password": "..."}

Or raw geth keystore format with a top-level "password" field.
"""
import sys
import os
import json

sys.path.insert(0, "/app")

from s3_wallet_store import upload_wallet, generate_presigned_url, ensure_bucket

def main():
    if len(sys.argv) < 2:
        print("Usage: python upload_to_s3.py <wallet.json>")
        sys.exit(1)

    fpath = sys.argv[1]
    with open(fpath, "r") as f:
        data = json.load(f)

    # Normalize format
    if "keystore" in data and "address" in data:
        wallet_data = {
            "address": data["address"],
            "keystore": data["keystore"],
            "password": data.get("password", "")
        }
    elif "crypto" in data and "address" in data:
        wallet_data = {
            "address": data["address"],
            "keystore": data,
            "password": data.get("password", "")
        }
    else:
        print("Invalid wallet format. Expected: {address, keystore, password}")
        sys.exit(1)

    print(f"Uploading wallet {wallet_data['address']} to S3...")
    ensure_bucket()
    object_key = upload_wallet(wallet_data)
    url = generate_presigned_url(object_key, expiry_seconds=3600)
    print(f"Object key: {object_key}")
    print(f"Pre-signed URL (expires in 1h): {url}")

if __name__ == "__main__":
    main()
