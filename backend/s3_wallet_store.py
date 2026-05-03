import os
import json
import uuid
from datetime import datetime, timedelta
from typing import Optional, Dict, Any

try:
    import boto3
    from botocore.config import Config
    from botocore.exceptions import ClientError
    HAS_BOTO3 = True
except ImportError:
    HAS_BOTO3 = False

S3_ENDPOINT = os.environ.get("S3_ENDPOINT", "")
S3_ACCESS_KEY = os.environ.get("S3_ACCESS_KEY", "")
S3_SECRET_KEY = os.environ.get("S3_SECRET_KEY", "")
S3_BUCKET = os.environ.get("S3_BUCKET", "livepeer-wallets")
S3_REGION = os.environ.get("S3_REGION", "us-east-1")
S3_URL_EXPIRY_SECONDS = int(os.environ.get("S3_URL_EXPIRY_SECONDS", "600"))
S3_OBJECT_TTL_HOURS = int(os.environ.get("S3_OBJECT_TTL_HOURS", "24"))

def _get_s3_client():
    if not HAS_BOTO3:
        raise RuntimeError("boto3 not installed")
    if not S3_ENDPOINT or not S3_ACCESS_KEY or not S3_SECRET_KEY:
        raise RuntimeError("S3 credentials not configured (S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY)")
    return boto3.client(
        "s3",
        endpoint_url=S3_ENDPOINT,
        aws_access_key_id=S3_ACCESS_KEY,
        aws_secret_access_key=S3_SECRET_KEY,
        region_name=S3_REGION,
        config=Config(signature_version="s3v4")
    )

def ensure_bucket():
    """Create the S3 bucket if it doesn't exist."""
    client = _get_s3_client()
    try:
        client.head_bucket(Bucket=S3_BUCKET)
    except ClientError as e:
        error_code = e.response["Error"]["Code"]
        if error_code == "404":
            client.create_bucket(Bucket=S3_BUCKET)
            # Set lifecycle rule to auto-delete objects after TTL
            lifecycle = {
                "Rules": [
                    {
                        "ID": "wallet-cleanup",
                        "Status": "Enabled",
                        "Filter": {"Prefix": "wallets/"},
                        "Expiration": {"Days": 1}
                    }
                ]
            }
            try:
                client.put_bucket_lifecycle_configuration(
                    Bucket=S3_BUCKET,
                    LifecycleConfiguration=lifecycle
                )
            except Exception:
                pass
            # Block all public access
            try:
                client.put_public_access_block(
                    Bucket=S3_BUCKET,
                    PublicAccessBlockConfiguration={
                        "BlockPublicAcls": True,
                        "IgnorePublicAcls": True,
                        "BlockPublicPolicy": True,
                        "RestrictPublicBuckets": True
                    }
                )
            except Exception:
                pass
        else:
            raise

def upload_wallet(wallet_data: Dict[str, Any]) -> str:
    """Upload wallet to S3 and return the object key."""
    client = _get_s3_client()
    ensure_bucket()
    object_key = f"wallets/{uuid.uuid4().hex}.json"
    body = json.dumps(wallet_data).encode("utf-8")
    client.put_object(
        Bucket=S3_BUCKET,
        Key=object_key,
        Body=body,
        ContentType="application/json",
        Metadata={
            "uploaded": datetime.utcnow().isoformat(),
            "address": wallet_data.get("address", "")
        }
    )
    return object_key

def generate_presigned_url(object_key: str, expiry_seconds: int = None) -> str:
    """Generate a time-limited pre-signed download URL."""
    client = _get_s3_client()
    expiry = expiry_seconds or S3_URL_EXPIRY_SECONDS
    url = client.generate_presigned_url(
        "get_object",
        Params={"Bucket": S3_BUCKET, "Key": object_key},
        ExpiresIn=expiry
    )
    return url

def delete_object(object_key: str):
    """Delete a wallet object from S3."""
    if not object_key:
        return
    try:
        client = _get_s3_client()
        client.delete_object(Bucket=S3_BUCKET, Key=object_key)
    except Exception:
        pass

def is_configured() -> bool:
    """Check if S3 is properly configured."""
    return HAS_BOTO3 and bool(S3_ENDPOINT and S3_ACCESS_KEY and S3_SECRET_KEY)
