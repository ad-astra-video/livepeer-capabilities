#!/usr/bin/env python3
"""
Upload keystore and password to S3 as separate objects.

Naming convention:
  Keystore: wallets/keystore/0x<address>.json
  Password: wallets/password/0x<address>.password

Usage:
    export S3_ENDPOINT=https://ewr1.vultrobjects.com
    export S3_ACCESS_KEY=xxx
    export S3_SECRET_KEY=xxx
    export S3_BUCKET=livepeer-wallets

    python upload_to_s3.py my-keystore.json my-password.txt
    # or
    python upload_to_s3.py my-wallet.json
    # (if my-wallet.json contains keystore + password fields, splits automatically)
"""

import os
import sys
import json

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


def upload_from_combined(fpath: str):
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
    keystore_key = f"wallets/keystore/{address}.json"
    password_key = f"wallets/password/{address}.password"

    upload_object(keystore_key, json.dumps(keystore).encode("utf-8"), "application/json")
    upload_object(password_key, password.encode("utf-8"), "text/plain")
    print("Done.")


def upload_separate(keystore_path: str, password_path: str):
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
    keystore_key = f"wallets/keystore/{address}.json"
    password_key = f"wallets/password/{address}.password"

    upload_object(keystore_key, json.dumps(keystore).encode("utf-8"), "application/json")
    upload_object(password_key, password.encode("utf-8"), "text/plain")
    print("Done.")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    if len(sys.argv) == 2:
        upload_from_combined(sys.argv[1])
    else:
        upload_separate(sys.argv[1], sys.argv[2])
