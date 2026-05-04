# Secure Wallet Delivery via S3

Wallets live **only in S3** — they never touch the backend server's filesystem. You upload wallet JSON files directly to your S3-compatible bucket, and the backend discovers them there.

## Why S3-Only?

- **No wallet files on the backend disk** — eliminates a major attack surface
- **Cloud-init user-data has a ~64KB limit** and is visible in the Vultr API/console
- **Pre-signed S3 URLs** grant temporary, time-limited access (default: 10 minutes)
- **S3 objects are private by default** — no download without the signed URL
- **S3 SSE-S3 (AES-256)** encrypts wallets at rest automatically
- **One-time download** — instance notifies backend, object deleted immediately

## Configuration

Add these to your `.env` file:

```bash
# S3-compatible object storage (Vultr Object Storage, AWS S3, MinIO, etc.)
S3_ENDPOINT=https://ewr1.vultrobjects.com
S3_ACCESS_KEY=your-access-key
S3_SECRET_KEY=your-secret-key
S3_BUCKET=livepeer-wallets
S3_REGION=us-east-1
S3_URL_EXPIRY_SECONDS=600
```

### Vultr Object Storage Example

1. Create Object Storage in Vultr dashboard
2. Note the **S3-compatible endpoint** (e.g., `https://ewr1.vultrobjects.com`)
3. Create a bucket (e.g., `livepeer-wallets`)
4. Generate **S3 credentials** (Access Key + Secret Key)
5. Add to `.env`

## How It Works

### Wallet Upload (Manual)

```bash
# Set your S3 credentials
export S3_ENDPOINT=https://ewr1.vultrobjects.com
export S3_ACCESS_KEY=xxx
export S3_SECRET_KEY=xxx
export S3_BUCKET=livepeer-wallets

# Upload a wallet
python data/wallets/upload_to_s3.py my-wallet.json
```

### Instance Creation Flow

```
S3 Bucket (wallets/)            Backend                          Vultr Instance
  |                                 |                                   |
  |<-- 1. admin uploads wallet ----|                                   |
  |                                 |                                   |
  |-- 2. list objects ------------->|                                   |
  |                                 |                                   |
  |-- 3. generate pre-signed URL --|                                   |
  |                                 |                                   |
  |                                 |-- 4. create instance ----------->|
  |                                 |   (cloud-init gets URL only)     |
  |                                 |                                   |
  |                                 |<-- 5. download wallet -----------|
  |                                 |   (via pre-signed URL)           |
  |                                 |                                   |
  |<-- 6. notify downloaded --------|                                   |
  |   (/wallet-downloaded endpoint) |                                   |
  |                                 |                                   |
  |-- 7. delete S3 object --------->|                                   |
```

### Instance Destroy Flow

```
Backend                          Vultr Instance
  |                                 |
  |-- 1. send wipe command -------->|
  |   (overwrites & deletes wallet) |
  |                                 |
  |-- 2. destroy instance --------->|
 |                                 |
  |-- 3. delete S3 object (if any)  |
```

## Wallet File Format

Your wallet JSON must contain the address, keystore, and password:

```json
{
  "address": "0x68d6ff3938ff63d2df16567cb8ca9772e14496f7",
  "keystore": {
    "address": "68d6ff3938ff63d2df16567cb8ca9772e14496f7",
    "crypto": { ... },
    "id": "...",
    "version": 3
  },
  "password": "your-wallet-password"
}
```

**Naming convention:** The upload script names the S3 object `wallets/0x<address>.json`. The backend discovers wallets by listing objects under the `wallets/` prefix and parsing the address from the filename.

## Uploading Wallets to S3

### Using the upload script

```bash
cd /mnt/c/dev/livepeer/capabilities
python data/wallets/upload_to_s3.py /path/to/my-wallet.json
```

This will:
1. Read the wallet JSON
2. Extract the Ethereum address
3. Upload to `s3://<bucket>/wallets/0x<address>.json`
4. Enable SSE-S3 (AES-256) encryption at rest

### Using AWS CLI / s3cmd

```bash
# AWS CLI
aws s3 cp my-wallet.json s3://livepeer-wallets/wallets/0x68d6ff3938ff63d2df16567cb8ca9772e14496f7.json \
  --sse AES256

# s3cmd
s3cmd put my-wallet.json s3://livepeer-wallets/wallets/0x68d6ff3938ff63d2df16567cb8ca9772e14496f7.json
```

### Using the Vultr web UI

Upload directly in the Vultr Object Storage dashboard to the `wallets/` folder.

## Encryption at Rest

Wallets in S3 are encrypted automatically using **SSE-S3 (AES-256)**. This is handled transparently by S3:

- Data is encrypted before being written to disk
- Data is decrypted when downloaded via authenticated API calls
- No code changes needed on the backend or worker

If you need stronger control, enable **SSE-KMS** on your bucket or use your cloud provider's key management service.

## Security Features

1. **No wallets on backend disk** — S3 is the only storage
2. **Private S3 bucket** — public access is blocked
3. **SSE-S3 encryption** — AES-256 at rest
4. **Pre-signed URLs** — time-limited, cryptographically signed
5. **One-time download** — instance notifies backend, object deleted immediately
6. **Lifecycle cleanup** — objects auto-deleted after 24 hours if not cleaned up
7. **Secure wipe on destroy** — wallet files overwritten with random bytes before deletion
8. **No wallet secrets in cloud-init** — only a temporary URL is passed to the instance
9. **Password travels with keystore** — both in the same S3 payload, never in user-data
10. **RAM-only keystore** — tmpfs mounts with mode 700, never touches persistent disk

## Fallback Behavior

If S3 is **not configured** (missing env vars), instance creation will fail with a clear error: "S3 wallet pool is empty." There is no fallback to local files or user-data embedding.
