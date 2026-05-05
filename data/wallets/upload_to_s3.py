#!/usr/bin/env python3
"""
Upload keystore and password to S3 as separate objects.

This is a standalone convenience tool. The backend discovers wallets by
looking for marker files in its local pool directory (default: /data/wallets/)
named '0x<address>.address'. These marker files can be blank — only the filename
matters.

Naming convention in S3:
  Keystore: wallets/keystore/0x<address>.json
  Password: wallets/password/0x<address>.password

Usage:
    export S3_ENDPOINT=https://ewr1.vultrobjects.com
    export S3_ACCESS_KEY=xxx
    export S3_SECRET_KEY=xxx
    export S3_BUCKET=livepeer-wallets

    # Upload keystore + password, create local marker file
    python upload_to_s3.py my-keystore.json my-password.txt --marker /data/wallets/

    # Upload keystore + password only (no marker)
    python upload_to_s3.py my-keystore.json my-password.txt

    # Upload from a combined JSON (splits automatically)
    python upload_to_s3.py my-wallet.json --marker /data/wallets/

    # Create marker in a subfolder (transcoding, ai-batch, lv2v, etc.)
    python upload_to_s3.py my-keystore.json my-password.txt --marker /data/wallets/ --subfolder transcoding
"""

import os
import sys
import json
import argparse

try:
    import boto3
    from botocore.config import Config
except ImportError:
    print("ERROR: boto3 not installed. Run: pip install boto3")
    sys.exit(1)

S3_ENDPOINT = os.environ.get("S3_ENDPOINT", "")
S3_ACCESS_KEY = os.environ.get("S3_ACCESS_KEY", "")
S3_SECRET_KEY = os.environ.get("S3_SECRET_KEY", "")
S3_BUCKET = os.environ.get("S3_BUCKET", "livepeer-wallets")
S3_REGION = os.environ.get("S3_REGION", "us-east-1")


def get_s3_client():
    if not S3_ENDPOINT or not S3_ACCESS_KEY or not S3_SECRET_KEY:
        print("ERROR: S3 credentials not configured. Set S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY")
        sys.exit(1)
    return boto3.client(
        "s3",
        endpoint_url=S3_ENDPOINT,
        aws_access_key_id=S3_ACCESS_KEY,
        aws_secret_access_key=S3_SECRET_KEY,
        region_name=S3_REGION,
        config=Config(signature_version="s3v4")
    )


def upload_object(object_key: str, body: bytes, content_type: str = "application/octet-stream"):
    client = get_s3_client()
    client.put_object(
        Bucket=S3_BUCKET,
        Key=object_key,
        Body=body,
        ContentType=content_type,
        ServerSideEncryption="AES256",
        Metadata={"purpose": "livepeer-wallet"}
    )
    print(f"  s3://{S3_BUCKET}/{object_key}")


def create_marker(address: str, marker_dir: str, subfolder: str = None):
    """Create a blank marker file named 0x<address>.address in the pool directory."""
    if subfolder:
        marker_dir = os.path.join(marker_dir, subfolder)
    os.makedirs(marker_dir, exist_ok=True)
    fpath = os.path.join(marker_dir, f"{address.lower()}.address")
    if os.path.exists(fpath):
        print(f"  Marker already exists: {fpath}")
    else:
        with open(fpath, "w") as f:
            pass  # blank file
        print(f"  Created marker: {fpath}")


def upload_from_combined(fpath: str, marker_dir: str = None, subfolder: str = None):
    """Upload from a combined JSON file containing keystore + password."""
    with open(fpath, "r") as f:
        data = json.load(f)

    address = data.get("address", "")
    if not address:
        print("ERROR: Wallet file missing 'address' field")
        sys.exit(1)

    address = address.lower()
    password = data.get("password", "")
    if not password:
        print("ERROR: Wallet file missing 'password' field")
        sys.exit(1)

    keystore = data.get("keystore", data)
    if "crypto" not in keystore:
        print("ERROR: Wallet file missing keystore 'crypto' field")
        sys.exit(1)

    print(f"Uploading wallet {address}")
    keystore_key = f"keystore/{address}.json"
    password_key = f"password/{address}.password"

    upload_object(keystore_key, json.dumps(keystore).encode("utf-8"), "application/json")
    upload_object(password_key, password.encode("utf-8"), "text/plain")

    if marker_dir:
        create_marker(address, marker_dir, subfolder)

    print("Done.")


def upload_separate(keystore_path: str, password_path: str, marker_dir: str = None, subfolder: str = None):
    """Upload separate keystore JSON and password files."""
    with open(keystore_path, "r") as f:
        keystore = json.load(f)

    address = keystore.get("address", "")
    if not address:
        print("ERROR: Keystore file missing 'address' field")
        sys.exit(1)

    address = address.lower()

    with open(password_path, "r") as f:
        password = f.read().strip()

    if not password:
        print("ERROR: Password file is empty")
        sys.exit(1)

    print(f"Uploading wallet {address}")
    keystore_key = f"keystore/{address}.json"
    password_key = f"password/{address}.password"

    upload_object(keystore_key, json.dumps(keystore).encode("utf-8"), "application/json")
    upload_object(password_key, password.encode("utf-8"), "text/plain")

    if marker_dir:
        create_marker(address, marker_dir, subfolder)

    print("Done.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Upload wallet keystore and password to S3")
    parser.add_argument("files", nargs="+", help="Combined JSON, or keystore + password files")
    parser.add_argument("--marker", "-m", help="Directory to create blank marker file (e.g., /data/wallets/)")
    parser.add_argument("--subfolder", "-s", help="Subfolder under marker dir (e.g., transcoding, ai-batch, lv2v)")
    args = parser.parse_args()

    if len(args.files) == 1:
        upload_from_combined(args.files[0], args.marker, args.subfolder)
    elif len(args.files) == 2:
        upload_separate(args.files[0], args.files[1], args.marker, args.subfolder)
    else:
        parser.print_help()
        sys.exit(1)
