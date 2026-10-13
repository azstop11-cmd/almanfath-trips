import os
import shutil
import sqlite3
import datetime
from typing import List, Dict, Any

from database import DB_PATH, BACKUPS_DIR

def ensure_backup_dir():
    os.makedirs(BACKUPS_DIR, exist_ok=True)

def create_backup(label: str = "auto") -> str:
    """
    Creates an atomic, lock-safe SQLite backup of the database.
    """
    ensure_backup_dir()
    if not os.path.exists(DB_PATH):
        return ""

    timestamp = datetime.datetime.now().strftime("%Y-%m-%d_%H%M%S")
    backup_filename = f"almanfath_backup_{timestamp}_{label}.db"
    backup_filepath = os.path.join(BACKUPS_DIR, backup_filename)

    # Use native SQLite atomic backup
    src_conn = sqlite3.connect(DB_PATH)
    dst_conn = sqlite3.connect(backup_filepath)
    src_conn.backup(dst_conn)
    dst_conn.close()
    src_conn.close()

    # Also maintain a permanent stable copy: almanfath_trips_latest_stable.db
    stable_copy = os.path.join(BACKUPS_DIR, "almanfath_trips_latest_stable.db")
    try:
        shutil.copy2(backup_filepath, stable_copy)
    except Exception:
        pass

    # Prune old backups (keep latest 50)
    prune_old_backups(keep=50)

    return backup_filename

def list_backups() -> List[Dict[str, Any]]:
    """
    Returns a sorted list of available backups (newest first).
    """
    ensure_backup_dir()
    files = []
    for f in os.listdir(BACKUPS_DIR):
        if f.endswith(".db"):
            fp = os.path.join(BACKUPS_DIR, f)
            stat = os.stat(fp)
            size_kb = round(stat.st_size / 1024, 1)
            created_at = datetime.datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S")
            files.append({
                "filename": f,
                "size_kb": size_kb,
                "size_display": f"{size_kb} KB" if size_kb < 1024 else f"{round(size_kb/1024, 2)} MB",
                "created_at": created_at,
                "timestamp": stat.st_mtime
            })
    files.sort(key=lambda x: x["timestamp"], reverse=True)
    return files

def restore_backup(backup_filename: str) -> bool:
    """
    Restores the database from a given backup file.
    Takes a snapshot of current DB before overwriting.
    """
    ensure_backup_dir()
    target_backup_path = os.path.join(BACKUPS_DIR, backup_filename)
    if not os.path.exists(target_backup_path):
        raise FileNotFoundError(f"ملف النسخة الاحتياطية غير موجود: {backup_filename}")

    # Safety snapshot of current database before restoring
    if os.path.exists(DB_PATH):
        pre_restore_snap = os.path.join(BACKUPS_DIR, f"pre_restore_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}.db")
        shutil.copy2(DB_PATH, pre_restore_snap)

    # Perform atomic restore
    src_conn = sqlite3.connect(target_backup_path)
    dst_conn = sqlite3.connect(DB_PATH)
    src_conn.backup(dst_conn)
    dst_conn.close()
    src_conn.close()

    return True

def prune_old_backups(keep: int = 50):
    try:
        all_backups = list_backups()
        # Don't prune the latest_stable.db file
        timestamped = [b for b in all_backups if "backup_" in b["filename"]]
        if len(timestamped) > keep:
            for b in timestamped[keep:]:
                fp = os.path.join(BACKUPS_DIR, b["filename"])
                if os.path.exists(fp):
                    os.remove(fp)
    except Exception as e:
        print("Warning pruning backups:", e)
