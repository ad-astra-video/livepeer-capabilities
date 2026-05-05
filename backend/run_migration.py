import sqlite3
import os

DB_PATH = "/mnt/c/dev/livepeer/capabilities/data/admin/admin.db"
conn = sqlite3.connect(DB_PATH)
cursor = conn.cursor()
cursor.execute("PRAGMA table_info(users)")
columns = [col[1] for col in cursor.fetchall()]
if "token_version" not in columns:
    cursor.execute("ALTER TABLE users ADD COLUMN token_version INTEGER DEFAULT 0")
    print("Added token_version column")
else:
    print("token_version already exists")
conn.commit()
conn.close()
