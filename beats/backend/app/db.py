import json
import os
import sqlite3
import time
from pathlib import Path

from .config import settings

DB_PATH = Path(settings.db_dir) / "beats.db"
DB_PATH.parent.mkdir(parents=True, exist_ok=True)


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _ensure_columns(conn: sqlite3.Connection) -> None:
    """Add columns introduced after the first release, if an older DB is present."""
    existing = {row["name"] for row in conn.execute("PRAGMA table_info(tracks)")}
    migrations = {
        "title": "ALTER TABLE tracks ADD COLUMN title TEXT",
        "description": "ALTER TABLE tracks ADD COLUMN description TEXT",
        "is_public": "ALTER TABLE tracks ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0",
        "size_bytes": "ALTER TABLE tracks ADD COLUMN size_bytes INTEGER",
    }
    for column, statement in migrations.items():
        if column not in existing:
            conn.execute(statement)
    conn.commit()


def _backfill_sizes(conn: sqlite3.Connection) -> None:
    """Record file sizes for tracks uploaded before quotas existed."""
    storage = Path(settings.storage_dir)
    rows = conn.execute("SELECT id FROM tracks WHERE size_bytes IS NULL").fetchall()
    for row in rows:
        try:
            size = (storage / os.path.basename(row["id"])).stat().st_size
        except OSError:
            size = 0
        conn.execute("UPDATE tracks SET size_bytes = ? WHERE id = ?", (size, row["id"]))
    conn.commit()


def init_db() -> None:
    conn = get_conn()
    # WAL lets readers proceed while an upload or play count is being written.
    conn.execute("PRAGMA journal_mode = WAL")
    # `users` is a local mirror of the central platform accounts, keyed by the
    # platform user id. It exists only so track ownership (uploader) resolves via
    # a join; passwords/auth live in the accounts service, not here.
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY,
            username TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tracks (
            id TEXT PRIMARY KEY,
            original_name TEXT NOT NULL,
            uploader_id INTEGER REFERENCES users(id),
            uploaded_at INTEGER NOT NULL,
            duration_seconds REAL,
            waveform_json TEXT,
            play_count INTEGER NOT NULL DEFAULT 0,
            title TEXT,
            description TEXT,
            is_public INTEGER NOT NULL DEFAULT 0,
            size_bytes INTEGER
        );
        """
    )
    conn.commit()
    _ensure_columns(conn)
    _backfill_sizes(conn)
    conn.close()


def upsert_user(user_id: int, username: str) -> None:
    """Mirror a platform account locally (called on each authenticated request)."""
    conn = get_conn()
    try:
        conn.execute(
            """INSERT INTO users (id, username, created_at) VALUES (?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET username = excluded.username""",
            (user_id, username, int(time.time())),
        )
        conn.commit()
    finally:
        conn.close()


def create_track_meta(
    track_id: str,
    original_name: str,
    uploader_id: int | None,
    duration_seconds: float | None,
    waveform: list[float] | None,
    title: str | None = None,
    description: str | None = None,
    is_public: bool = False,
    size_bytes: int | None = None,
) -> None:
    conn = get_conn()
    try:
        conn.execute(
            """INSERT INTO tracks
               (id, original_name, uploader_id, uploaded_at, duration_seconds,
                waveform_json, title, description, is_public, size_bytes)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                track_id,
                original_name,
                uploader_id,
                int(time.time()),
                duration_seconds,
                json.dumps(waveform) if waveform else None,
                title,
                description,
                1 if is_public else 0,
                size_bytes,
            ),
        )
        conn.commit()
    finally:
        conn.close()


def _row_to_meta(row: sqlite3.Row) -> dict:
    return {
        "original_name": row["original_name"],
        "uploaded_at": row["uploaded_at"],
        "duration_seconds": row["duration_seconds"],
        "waveform": json.loads(row["waveform_json"]) if row["waveform_json"] else None,
        "play_count": row["play_count"],
        "uploader": row["uploader"],
        "uploader_id": row["uploader_id"],
        "title": row["title"],
        "description": row["description"],
        "is_public": bool(row["is_public"]),
    }


_SELECT_META = """
    SELECT t.id, t.original_name, t.uploaded_at, t.duration_seconds,
           t.waveform_json, t.play_count, t.uploader_id, t.title,
           t.description, t.is_public, u.username as uploader
    FROM tracks t LEFT JOIN users u ON u.id = t.uploader_id
"""


def get_tracks_meta_by_id() -> dict[str, dict]:
    conn = get_conn()
    try:
        rows = conn.execute(_SELECT_META).fetchall()
        return {row["id"]: _row_to_meta(row) for row in rows}
    finally:
        conn.close()


def get_track_meta(track_id: str) -> dict | None:
    conn = get_conn()
    try:
        row = conn.execute(_SELECT_META + " WHERE t.id = ?", (track_id,)).fetchone()
        return _row_to_meta(row) if row else None
    finally:
        conn.close()


def increment_play_count(track_id: str) -> None:
    conn = get_conn()
    try:
        conn.execute("UPDATE tracks SET play_count = play_count + 1 WHERE id = ?", (track_id,))
        conn.commit()
    finally:
        conn.close()


def set_visibility(track_id: str, is_public: bool) -> None:
    conn = get_conn()
    try:
        conn.execute("UPDATE tracks SET is_public = ? WHERE id = ?", (1 if is_public else 0, track_id))
        conn.commit()
    finally:
        conn.close()


def storage_used_by(user_id: int) -> int:
    conn = get_conn()
    try:
        row = conn.execute(
            "SELECT COALESCE(SUM(size_bytes), 0) AS used FROM tracks WHERE uploader_id = ?",
            (user_id,),
        ).fetchone()
        return int(row["used"])
    finally:
        conn.close()


def track_ids_by_uploader(user_id: int) -> list[str]:
    conn = get_conn()
    try:
        rows = conn.execute("SELECT id FROM tracks WHERE uploader_id = ?", (user_id,)).fetchall()
        return [row["id"] for row in rows]
    finally:
        conn.close()


def delete_track_meta(track_id: str) -> None:
    conn = get_conn()
    try:
        conn.execute("DELETE FROM tracks WHERE id = ?", (track_id,))
        conn.commit()
    finally:
        conn.close()


def delete_user(user_id: int) -> None:
    conn = get_conn()
    try:
        conn.execute("DELETE FROM tracks WHERE uploader_id = ?", (user_id,))
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
        conn.commit()
    finally:
        conn.close()
