"""Authorization and abuse-limit regression tests for the beats API.

Run from beats/:  pip install -r backend/requirements.txt pytest httpx
                  pytest tests
"""

import json
import os
import sys
import tempfile
from pathlib import Path

import pytest

_tmp = Path(tempfile.mkdtemp(prefix="beats-test-"))
(_tmp / "static").mkdir()
os.environ.update({
    "SIGNING_SECRET": "test-signing-secret",
    "GATEWAY_SECRET": "test-gateway-secret",
    "STORAGE_DIR": str(_tmp / "storage"),
    "DB_DIR": str(_tmp / "db"),
    "STATIC_DIR": str(_tmp / "static"),
    "USER_QUOTA_MB": "1",
    "MIN_FREE_DISK_MB": "0",
})
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


def as_user(user_id, name, secret="test-gateway-secret"):
    return {"X-Auth-User-Id": str(user_id), "X-Auth-Username": name, "X-Gateway-Secret": secret}


ALICE = as_user(1, "alice")
BOB = as_user(2, "bob")


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def upload(client, headers, name="beat.mp3", size=1000, public=False, **extra):
    data = {"title": name, "is_public": "1" if public else "0", **extra}
    res = client.post("/api/upload", headers=headers, data=data, files={"file": (name, b"\0" * size, "audio/mpeg")})
    return res


def test_identity_headers_without_gateway_secret_are_ignored(client):
    assert client.get("/api/tracks", headers=as_user(1, "alice", secret="wrong")).status_code == 401
    headers = dict(ALICE)
    del headers["X-Gateway-Secret"]
    assert client.get("/api/tracks", headers=headers).status_code == 401


def test_private_track_is_only_streamable_by_its_owner(client):
    track_id = upload(client, ALICE, "secret.mp3").json()["id"]
    assert client.get(f"/api/stream/{track_id}", headers=ALICE).status_code == 200
    assert client.get(f"/api/stream/{track_id}", headers=BOB).status_code == 404
    assert client.post(f"/api/tracks/{track_id}/play", headers=BOB).status_code == 404
    assert client.get(f"/api/tracks/{track_id}/share", headers=BOB).status_code == 404
    assert client.get(f"/api/stream/{track_id}").status_code == 401


def test_share_token_grants_access_to_that_track_only(client):
    private_id = upload(client, ALICE, "shared.mp3").json()["id"]
    other_id = upload(client, ALICE, "other.mp3").json()["id"]
    token = client.get(f"/api/tracks/{private_id}/share", headers=ALICE).json()["token"]
    assert client.get(f"/api/stream/{private_id}", params={"token": token}).status_code == 200
    assert client.get(f"/api/stream/{other_id}", params={"token": token}).status_code == 401


def test_public_track_is_streamable_by_others(client):
    track_id = upload(client, ALICE, "public.mp3", public=True).json()["id"]
    assert client.get(f"/api/stream/{track_id}", headers=BOB).status_code == 200


def test_only_the_owner_can_change_or_delete_a_track(client):
    track_id = upload(client, ALICE, "mine.mp3").json()["id"]
    assert client.patch(f"/api/tracks/{track_id}", headers=BOB, json={"is_public": True}).status_code == 404
    assert client.delete(f"/api/tracks/{track_id}", headers=BOB).status_code == 404
    assert client.patch(f"/api/tracks/{track_id}", headers=ALICE, json={"is_public": True}).status_code == 200
    assert client.get(f"/api/stream/{track_id}", headers=BOB).status_code == 200
    assert client.delete(f"/api/tracks/{track_id}", headers=ALICE).status_code == 200
    assert client.get(f"/api/stream/{track_id}", headers=ALICE).status_code == 404


def test_storage_quota_is_enforced(client):
    carol = as_user(3, "carol")
    assert upload(client, carol, "a.mp3", size=600 * 1024).status_code == 200
    res = upload(client, carol, "b.mp3", size=600 * 1024)
    assert res.status_code == 413
    assert "space" in res.json()["detail"]
    quota = client.get("/api/tracks", headers=carol).json()["quota"]
    assert quota["used_bytes"] <= quota["limit_bytes"]


def test_waveform_and_duration_are_validated(client):
    dave = as_user(4, "dave")
    track_id = upload(client, dave, "w.mp3", waveform=json.dumps("not-a-list"), duration="nan").json()["id"]
    track = next(t for t in client.get("/api/tracks", headers=dave).json()["tracks"] if t["id"] == track_id)
    assert track["waveform"] is None
    assert track["duration_seconds"] is None


def test_account_purge_removes_all_of_the_users_tracks(client):
    erin = as_user(5, "erin")
    ids = [upload(client, erin, f"e{i}.mp3", public=True).json()["id"] for i in range(2)]
    assert client.delete("/api/me/data", headers=erin).json()["tracks"] == 2
    for track_id in ids:
        assert client.get(f"/api/stream/{track_id}", headers=ALICE).status_code == 404
