# Secure Wallet Delivery via S3

This system delivers Ethereum wallets to Vultr instances securely through S3-compatible object storage instead of embedding them directly in cloud-init user-data.

## Why S3?

- **Cloud-init user-data has a ~64KB limit** and is visible in the Vultr API/console
- **Pre-signed S3 URLs** grant temporary, time-limited access (default: 10 minutes)
- **S3 objects are private by default** — no download without the signed URL
- **Lifecycle rules** auto-delete objects after 24 hours as a safety net
- **Instance confirms download** — backend deletes the S3 object immediately after

## Configuration

Add these to your `.env` file:

```bash
# S3-compatible object storage (Vultr Object Storage, AWS S3, MinIO, etc.)
S3_ENDPOINT=https://ewr1.vultrobjects.com
S3_ACCESS_KEY=your-access-key
S3_SECRET_KEY=***
S3_BUCKET=livepeer-wallets
S3_REGION=us-east-1
S3_URL_EXPIRY_SECONDS=600

# Wallet pool encryption (optional but strongly recommended)
WALLET_MASTER_KEY=your-fernet-key-here
```

### Vultr Object Storage Example

1. Create Object Storage in Vultr dashboard
2. Note the **S3-compatible endpoint** (e.g., `https://ewr1.vultrobjects.com`)
3. Create a bucket (e.g., `livepeer-wallets`)
4. Generate **S3 credentials** (Access Key + Secret Key)
5. Add to `.env`

## How It Works

### Instance Creation Flow

```
Backend                          S3 Bucket                        Vultr Instance
  |                                 |                                   |
  |-- 1. get wallet --------------->|                                   |
  |   (from pool or generate)       |                                   |
  |                                 |                                   |
  |-- 2. upload wallet ------------>|                                   |
  |   (private object, random key)  |                                   |
  |                                 |                                   |
  |-- 3. generate pre-signed URL ---|                                   |
  |   (valid 10 min)                |                                   |
  |                                 |                                   |
  |-- 4. create Vultr instance ---->|                                   |
  |   (cloud-init gets URL only)    |                                   |
  |                                 |                                   |
  |                                 |<-- 5. download wallet ------------|
  |                                 |   (via pre-signed URL)            |
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

## Wallet File Formats

### Format A: Structured JSON (recommended)

```json
{
  "address": "0x68d6ff3938ff63d2df16567cb8ca9772e14496f7",
  "keystore": {
    "address": "68d6ff3938ff63d2df16567cb8ca9772e14496f7",
    "crypto": { ... },
    "id": "...",
    "version": 3
  },
  "password": "your-k...word"
}
```

### Format B: Raw Geth Keystore + Password

```json
{
  "address": "68d6ff3938ff63d2df16567cb8ca9772e14496f7",
  "crypto": { ... },
  "id": "...",
  "version": 3,
  "password": "your-k...word"
}
```

## Adding Wallets to the Pool

Drop `.json` wallet files into this folder (`data/wallets/`). The backend will pick them up when creating instances.

If the pool is empty and S3 is not configured, the backend auto-generates a new wallet.

If S3 is configured but the pool is empty, the backend auto-generates a wallet and uploads it to S3.

## Encrypting the Wallet Pool (Strongly Recommended)

Wallet files contain sensitive keystore data and passwords. You should encrypt them at rest on the backend filesystem.

### Step 1: Generate a Fernet master key

```bash
# Run inside the backend container or your local Python env
python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

This outputs a URL-safe base64-encoded key like:
```
gd8E1X2K6PBQJq3vHdHkT9mLzYwNr5sA_CbEfGhIjKl=
```

### Step 2: Set WALLET_MASTER_KEY in your environment

```bash
# Add to .env or export directly
WALLET_MASTER_KEY=gd8E1X2K6PBQJq3vHdHkT9mLzYwNr5sA_CbEfGhIjKl=
```

### Step 3: Encrypt existing wallet files

```bash
# Inside the backend container
cd /data/wallets
python3 << 'PYEOF'
import os
from cryptography.fernet import Fernet

key = os.environ.get("WALLET_MASTER_KEY", "")
if not key:
    print("WALLET_MASTER_KEY not set")
    exit(1)

f = Fernet(key.encode())
for fname in os.listdir("."):
    if fname.endswith(".json") and not fname.endswith(".used.json"):
        with open(fname, "rb") as file:
            data = file.read()
        encrypted = f.encrypt(data)
        with open(fname, "wb") as file:
            file.write(encrypted)
        print(f"Encrypted: {fname}")
print("Done.")
PYEOF
```

### Step 4: The backend auto-decrypts on load

`wallet_pool.py` automatically detects whether a file is encrypted (when `WALLET_MASTER_KEY` is set) and decrypts it before loading. No further action needed.

### Important Notes

- **Keep the master key safe** — if you lose it, you cannot decrypt your wallets
- **Back up the key** outside of the project directory (e.g., password manager, HSM)
- **Do not commit the key** to git — add it to `.env` which should be in `.gitignore`
- **Encrypt before deploying** — unencrypted wallet files on disk are a security risk

## Manual S3 Upload (for testing)

```bash
cd /mnt/c/dev/livepeer/capabilities
docker exec -it capabilities-backend python /data/wallets/upload_to_s3.py /data/wallets/my-wallet.json
```

## Security Features

1. **Private S3 bucket** — public access is blocked
2. **Pre-signed URLs** — time-limited, cryptographically signed
3. **One-time download** — instance notifies backend, object deleted immediately
4. **Lifecycle cleanup** — objects auto-deleted after 24 hours if not cleaned up
5. **Secure wipe on destroy** — wallet files overwritten with random bytes before deletion
6. **No wallet in cloud-init** — only a temporary URL is passed to the instance
7. **Password never in user-data** — password travels inside the wallet JSON via S3
8. **RAM-only keystore** — tmpfs mounts with mode 700, never touches persistent disk
9. **Encrypted pool at rest** — Fernet encryption protects wallet files on backend disk

## Fallback Behavior

If S3 is **not configured** (missing env vars), the system falls back to embedding the wallet directly in cloud-init user-data (previous behavior).
