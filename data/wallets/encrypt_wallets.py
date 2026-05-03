#!/usr/bin/env python3
"""
Encrypt or decrypt wallet files in the pool using Fernet symmetric encryption.

Usage:
    # Encrypt all .json wallet files
    WALLET_MASTER_KEY=xxx python encrypt_wallets.py encrypt

    # Decrypt all .json wallet files
    WALLET_MASTER_KEY=xxx python encrypt_wallets.py decrypt

    # Generate a new master key
    python encrypt_wallets.py generate-key
"""

import os
import sys

WALLET_POOL_DIR = os.environ.get("WALLET_POOL_DIR", "/data/wallets")
WALLET_MASTER_KEY = os.environ.get("WALLET_MASTER_KEY", "")

def get_fernet():
    try:
        from cryptography.fernet import Fernet
    except ImportError:
        print("ERROR: cryptography library not installed. Run: pip install cryptography")
        sys.exit(1)
    if not WALLET_MASTER_KEY:
        print("ERROR: WALLET_MASTER_KEY environment variable not set")
        sys.exit(1)
    return Fernet(WALLET_MASTER_KEY.encode())

def get_wallet_files():
    files = []
    for fname in sorted(os.listdir(WALLET_POOL_DIR)):
        if fname.endswith(".json") and not fname.endswith(".used.json"):
            files.append(os.path.join(WALLET_POOL_DIR, fname))
    return files

def encrypt_files():
    f = get_fernet()
    files = get_wallet_files()
    if not files:
        print(f"No wallet files found in {WALLET_POOL_DIR}")
        return
    for fpath in files:
        with open(fpath, "rb") as file:
            data = file.read()
        encrypted = f.encrypt(data)
        with open(fpath, "wb") as file:
            file.write(encrypted)
        print(f"Encrypted: {fpath}")
    print(f"Done. {len(files)} file(s) encrypted.")

def decrypt_files():
    f = get_fernet()
    files = get_wallet_files()
    if not files:
        print(f"No wallet files found in {WALLET_POOL_DIR}")
        return
    for fpath in files:
        with open(fpath, "rb") as file:
            data = file.read()
        try:
            decrypted = f.decrypt(data)
        except Exception as e:
            print(f"Skipped (not encrypted or wrong key): {fpath}")
            continue
        with open(fpath, "wb") as file:
            file.write(decrypted)
        print(f"Decrypted: {fpath}")
    print(f"Done.")

def generate_key():
    from cryptography.fernet import Fernet
    key = Fernet.generate_key()
    print(key.decode())

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1].lower()
    if cmd == "encrypt":
        encrypt_files()
    elif cmd == "decrypt":
        decrypt_files()
    elif cmd == "generate-key":
        generate_key()
    else:
        print(f"Unknown command: {cmd}")
        print(__doc__)
        sys.exit(1)
