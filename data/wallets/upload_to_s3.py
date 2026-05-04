#!/usr/bin/env python3
"""
Upload a wallet JSON file to S3 for use by worker instances.

Naming convention: the wallet address is read from the JSON and the S3 key
becomes 'wallets/0x<address>.json'. The backend discovers wallets by listing
objects under the 'wallets/' prefix.

Usage:
    export S3_ENDPOINT=https://ewr1.vultrobjects.com
    export S3_ACCESS_KEY=xxx
    export S3_SECRET_KEY=xxx
    export S3_BUCKET=livepeer-wallets

    python upload_to_s3.py my-wallet.json
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


def upload_wallet(fpath: str):
    with open(fpath, "r") as f:
        data = json.load(f)

    address = data.get("address", "")
    if not address:
        print("ERROR: Wallet file missing 'address' field")
        sys.exit(1)

    # Normalize address
    address = address.lower()
    object_key = f"wallets/{address}.json"

    client = get_s3_client()
    body = json.dumps(data).encode("utf-8")

    client.put_object(
        Bucket=S3_BUCKET,
        Key=object_key,
        Body=body,
        ContentType="application/json",
        ServerSideEncryption="AES256",  # S3 server-side encryption at rest
        Metadata={"address": address}
    )
    print(f"Uploaded: s3://{S3_BUCKET}/{object_key}")
    print(f"Address: {address}")
    print(f"Encryption: SSE-S3 (AES-256)")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    upload_wallet(sys.argv[1])
