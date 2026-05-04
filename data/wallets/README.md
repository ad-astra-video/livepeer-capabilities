# Secure Wallet Delivery via S3

Wallets live **only in S3** — the backend server never stores keystore or password data. Instead, the backend keeps **blank marker files** locally (named by Ethereum address) to track which wallets are available. When a worker is spawned, the backend generates two pre-signed S3 URLs — one for the keystore, one for the password — and the worker downloads both directly from S3.

## Architecture

```
Backend (local markers)          S3 Bucket (actual secrets)
  |                                |
  data/wallets/                    wallets/
    0xABC...json   ---------->     keystore/
    0xDEF...json                   0xABC...json
    0xGHI...json   ---------->     password/
                                   0xABC...password
```

- **Marker files** on backend: blank files named `0x<address>.json`. The filename is the only thing that matters.
- **Keystore** in S3: `wallets/keystore/0x<address>.json` — the actual encrypted keystore JSON.
- **Password** in S3: `wallets/password/0x<address>.password` — plain text password file.

## Why This Design?

- **No wallet secrets on backend disk** — only blank marker files
- **No combined secrets anywhere** — keystore and password are separate S3 objects
- **Defense in depth** — attacker needs both pre-signed URLs to use the wallet
- **Cloud-init user-data has a ~64KB limit** and is visible in the Vultr API/console
- **Pre-signed S3 URLs** grant temporary, time-limited access (default: 10 minutes)
- **S3 SSE-S3 (AES-256)** encrypts objects at rest automatically
- **One-time download** — instance notifies backend, both objects deleted immediately

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

## Setting Up a Wallet

### Step 1: Upload keystore and password to S3

**Option A: Using the upload script (combined JSON)**

If you have a combined JSON with `address`, `keystore`, and `password`:

```bash
cd /mnt/c/dev/livepeer/capabilities
python data/wallets/upload_to_s3.py my-wallet.json --marker /data/wallets/
```

**Option B: Using the upload script (separate files)**

```bash
python data/wallets/upload_to_s3.py my-keystore.json my-password.txt --marker /data/wallets/
```

**Option C: Using AWS CLI / s3cmd directly**

```bash
# Keystore
aws s3 cp my-keystore.json \
  s3://livepeer-wallets/wallets/keystore/0x68d6ff3938ff63d2df16567cb8ca9772e14496f7.json \
  --sse AES256

# Password
aws s3 cp my-password.txt \
  s3://livepeer-wallets/wallets/password/0x68d6ff3938ff63d2df16567cb8ca9772e14496f7.password \
  --sse AES256

# Create marker file on backend
touch /data/wallets/0x68d6ff3938ff63d2df16567cb8ca9772e14496f7.json
```

**Option D: Using the Vultr web UI**

Upload directly in the Vultr Object Storage dashboard, then create the marker file on the backend server.

### Step 2: Verify

```bash
# Check S3 objects exist
aws s3 ls s3://livepeer-wallets/wallets/keystore/
aws s3 ls s3://livepeer-wallets/wallets/password/

# Check marker files on backend
ls /data/wallets/
```

## How It Works

### Instance Creation Flow

```
Backend                          S3 Bucket                        Vultr Instance
  |                                 |                                   |
  |-- 1. list marker files -------->|                                   |
  |   (0x<address>.json)            |                                   |
  |                                 |                                   |
  |-- 2. pick available marker ---->|                                   |
  |                                 |                                   |
  |-- 3. generate pre-signed URLs --|                                   |
  |   (keystore + password)         |                                   |
  |                                 |                                   |
  |-- 4. create Vultr instance ---->|                                   |
  |   (cloud-init gets 2 URLs only) |                                   |
  |                                 |                                   |
  |                                 |<-- 5. download keystore ----------|
  |                                 |<-- 5. download password ----------|
  |                                 |   (via separate pre-signed URLs)  |
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

### Keystore JSON

Standard Ethereum keystore JSON (V3):

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

## Marker Files

Marker files are **blank text files** on the backend filesystem. Only the filename matters.

```bash
# Create a marker for address 0x68d6ff3938ff63d2df16567cb8ca9772e14496f7
touch /data/wallets/0x68d6ff3938ff63d2df16567cb8ca9772e14496f7.json
```

When a wallet is allocated to an instance, the marker is renamed to `.used.json`:
```
0x68d6ff3938ff63d2df16567cb8ca9772e14496f7.json
  -> 0x68d6ff3938ff63d2df16567cb8ca9772e14496f7.used.json
```

This prevents double-allocation. When the instance is destroyed, the used marker is deleted.

## Encryption at Rest

Both keystore and password objects in S3 are encrypted automatically using **SSE-S3 (AES-256)**. This is handled transparently by S3:

- Data is encrypted before being written to disk
- Data is decrypted when downloaded via authenticated API calls
- No code changes needed on the backend or worker

If you need stronger control, enable **SSE-KMS** on your bucket or use your cloud provider's key management service.

## Security Features

1. **No wallet secrets on backend disk** — only blank marker files
2. **Separate keystore and password** — two S3 objects, two URLs, two downloads
3. **Backend never sees wallet content** — only parses address from marker filename
4. **Private S3 bucket** — public access is blocked
5. **SSE-S3 encryption** — AES-256 at rest for both objects
6. **Pre-signed URLs** — time-limited, cryptographically signed
7. **One-time download** — instance notifies backend, both objects deleted immediately
8. **Lifecycle cleanup** — objects auto-deleted after 24 hours if not cleaned up
9. **Secure wipe on destroy** — wallet files overwritten with random bytes before deletion
10. **No wallet secrets in cloud-init** — only two temporary URLs are passed to the instance
11. **RAM-only on workers** — tmpfs mounts with mode 700, never touches persistent disk

## Fallback Behavior

If the wallet pool is **empty** (no marker files in `/data/wallets/`), instance creation will fail with a clear error. There is no fallback to auto-generation or user-data embedding.
