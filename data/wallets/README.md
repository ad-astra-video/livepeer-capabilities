# Secure Wallet Delivery via S3

Wallets live **only in S3** as two separate objects — keystore and password are never combined on any server disk. The backend discovers them in S3, generates separate pre-signed URLs, and the worker downloads each independently.

## Why Separate Files?

- **Defense in depth** — attacker needs both URLs to use the wallet
- **Different IAM policies** — keystore and password can have separate access controls
- **No combined secrets anywhere** — not on backend disk, not in a single S3 object
- **Cloud-init user-data has a ~64KB limit** and is visible in the Vultr API/console
- **Pre-signed S3 URLs** grant temporary, time-limited access (default: 10 minutes)
- **S3 objects are private by default** — no download without the signed URL
- **S3 SSE-S3 (AES-256)** encrypts objects at rest automatically
- **One-time download** — instance notifies backend, objects deleted immediately

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

## S3 Object Structure

```
wallets/
  keystore/
    0x68d6ff3938ff63d2df16567cb8ca9772e14496f7.json
  password/
    0x68d6ff3938ff63d2df16567cb8ca9772e14496f7.password
```

The backend discovers wallets by listing objects under `wallets/keystore/` and computing the corresponding password key from the address in the filename.

## How It Works

### Wallet Upload (Manual)

```bash
# Set your S3 credentials
export S3_ENDPOINT=https://ewr1.vultrobjects.com
export S3_ACCESS_KEY=xxx
export S3_SECRET_KEY=xxx
export S3_BUCKET=livepeer-wallets

# Upload a combined wallet JSON (splits automatically)
python data/wallets/upload_to_s3.py my-wallet.json

# Or upload separate files
python data/wallets/upload_to_s3.py my-keystore.json my-password.txt
```

### Instance Creation Flow

```
S3 Bucket (wallets/)            Backend                          Vultr Instance
  |                                 |                                   |
  |<-- 1. admin uploads keystore --|                                   |
  |<--    admin uploads password --|                                   |
  |                                 |                                   |
  |-- 2. list keystore objects ---->|                                   |
  |                                 |                                   |
  |-- 3. generate pre-signed URLs -|                                   |
  |   (one for keystore, one for    |                                   |
  |    password)                    |                                   |
  |                                 |                                   |
  |                                 |-- 4. create instance ----------->|
  |                                 |   (cloud-init gets 2 URLs only)  |
  |                                 |                                   |
  |                                 |<-- 5. download keystore ---------|
  |                                 |<-- 5. download password ---------|
  |                                 |   (via separate pre-signed URLs) |
  |                                 |                                   |
  |<-- 6. notify downloaded --------|                                   |
  |   (/wallet-downloaded endpoint) |                                   |
  |                                 |                                   |
  |-- 7. delete both S3 objects --->|                                   |
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
  |-- 3. delete S3 objects (if any) |
```

## Wallet File Formats

### Keystore JSON (Format A — structured)

```json
{
  "address": "68d6ff3938ff63d2df16567cb8ca9772e14496f7",
  "crypto": { ... },
  "id": "...",
  "version": 3
}
```

### Keystore JSON (Format B — geth raw)

```json
{
  "address": "68d6ff3938ff63d2df16567cb8ca9772e14496f7",
  "crypto": { ... },
  "id": "...",
  "version": 3
}
```

### Password File

Plain text file containing the wallet password, one line:

```
your-wallet-password
```

## Uploading Wallets to S3

### Using the upload script (combined JSON)

If you have a combined JSON with `address`, `keystore`, and `password` fields:

```bash
cd /mnt/c/dev/livepeer/capabilities
python data/wallets/upload_to_s3.py my-wallet.json
```

This splits the keystore and password into two separate S3 objects automatically.

### Using the upload script (separate files)

If you already have separate files:

```bash
python data/wallets/upload_to_s3.py my-keystore.json my-password.txt
```

### Using AWS CLI / s3cmd directly

```bash
# Keystore
aws s3 cp my-keystore.json \
  s3://livepeer-wallets/wallets/keystore/0x68d6ff3938ff63d2df16567cb8ca9772e14496f7.json \
  --sse AES256

# Password
aws s3 cp my-password.txt \
  s3://livepeer-wallets/wallets/password/0x68d6ff3938ff63d2df16567cb8ca9772e14496f7.password \
  --sse AES256
```

### Using the Vultr web UI

Upload directly in the Vultr Object Storage dashboard to the `wallets/keystore/` and `wallets/password/` folders.

## Encryption at Rest

Both keystore and password objects are encrypted automatically using **SSE-S3 (AES-256)**. This is handled transparently by S3:

- Data is encrypted before being written to disk
- Data is decrypted when downloaded via authenticated API calls
- No code changes needed on the backend or worker

If you need stronger control, enable **SSE-KMS** on your bucket or use your cloud provider's key management service.

## Security Features

1. **No wallets on backend disk** — S3 is the only storage
2. **Separate keystore and password** — two objects, two URLs, two downloads
3. **Private S3 bucket** — public access is blocked
4. **SSE-S3 encryption** — AES-256 at rest for both objects
5. **Pre-signed URLs** — time-limited, cryptographically signed
6. **One-time download** — instance notifies backend, both objects deleted immediately
7. **Lifecycle cleanup** — objects auto-deleted after 24 hours if not cleaned up
8. **Secure wipe on destroy** — wallet files overwritten with random bytes before deletion
9. **No wallet secrets in cloud-init** — only two temporary URLs are passed to the instance
10. **RAM-only keystore** — tmpfs mounts with mode 700, never touches persistent disk

## Fallback Behavior

If S3 is **not configured** (missing env vars), instance creation will fail with a clear error: "S3 wallet pool is empty." There is no fallback to local files or user-data embedding.
