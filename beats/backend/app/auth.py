"""Identity for the beats tool.

This service no longer authenticates users itself. The platform gateway verifies
the shared session and, for every proxied request, injects two trusted headers:

    X-Auth-User-Id    the platform user id
    X-Auth-Username   the platform username

Because the beats backend is only reachable through the gateway on the internal
network (never published to the host), those headers are trusted. The gateway
strips any client-supplied X-Auth-* headers before setting its own, so they
cannot be spoofed by a browser.

The user is mirrored into the local database on each request so that track
ownership (uploader) keeps working with the existing schema.
"""

from fastapi import Header, HTTPException, status

from . import db


class CurrentUser:
    def __init__(self, id: int, username: str):
        self.id = id
        self.username = username


async def require_session(
    x_auth_user_id: str | None = Header(default=None),
    x_auth_username: str | None = Header(default=None),
) -> CurrentUser:
    if not x_auth_user_id or not x_auth_username:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    try:
        user_id = int(x_auth_user_id)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    # Keep a local mirror of the platform account so uploader joins resolve.
    db.upsert_user(user_id, x_auth_username)
    return CurrentUser(id=user_id, username=x_auth_username)


def header_identity_present(x_auth_user_id: str | None) -> bool:
    """Cheap check used by the streaming endpoint (which the gateway has already
    gated) to accept an authenticated request without a signed token."""
    return bool(x_auth_user_id)
