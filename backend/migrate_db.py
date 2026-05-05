import sqlite3
import os

DB_PATH = os.environ.get("DATABASE_PATH", "/data/admin.db")

def migrate():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    cursor.execute("PRAGMA table_info(instances)")
    columns = [col[1] for col in cursor.fetchall()]
    
    cursor.execute("PRAGMA table_info(users)")
    user_columns = [col[1] for col in cursor.fetchall()]
    
    if "token_version" not in user_columns:
        cursor.execute("ALTER TABLE users ADD COLUMN token_version INTEGER DEFAULT 0")
        print("Added token_version column to users")
    
    # Add new columns if missing
    if "wallet_address" not in columns:
        cursor.execute("ALTER TABLE instances ADD COLUMN wallet_address TEXT")
        print("Added wallet_address column")
    if "eth_password" not in columns:
        cursor.execute("ALTER TABLE instances ADD COLUMN eth_password TEXT")
        print("Added eth_password column")
    if "s3_object_key" not in columns:
        cursor.execute("ALTER TABLE instances ADD COLUMN s3_object_key TEXT")
        print("Added s3_object_key column")
    
    # Remove old wallet_keystore column if present (security: don't store keys in DB)
    if "wallet_keystore" in columns:
        # SQLite doesn't support DROP COLUMN, so we recreate the table
        cursor.execute("""
            CREATE TABLE instances_new (
                id INTEGER PRIMARY KEY,
                vultr_instance_id TEXT UNIQUE,
                region_id TEXT,
                label TEXT,
                ip_address TEXT,
                status TEXT DEFAULT 'pending',
                wallet_address TEXT,
                eth_password TEXT,
                s3_object_key TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_seen_at TIMESTAMP
            )
        """)
        cursor.execute("""
            INSERT INTO instances_new 
            SELECT id, vultr_instance_id, region_id, label, ip_address, status,
                   wallet_address, eth_password, s3_object_key, created_at, last_seen_at
            FROM instances
        """)
        cursor.execute("DROP TABLE instances")
        cursor.execute("ALTER TABLE instances_new RENAME TO instances")
        print("Removed wallet_keystore column (security: keys no longer stored in DB)")
    
    conn.commit()
    conn.close()
    print("Migration complete")

if __name__ == "__main__":
    migrate()
