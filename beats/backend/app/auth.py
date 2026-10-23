"""Identity for the beats tool.

This service does not authenticate users itself. The platform gateway verifies
the shared session and, for every proxied request, injects three trusted
headers:

    X-Auth-User-Id     the platform user id
    X-Auth-Username    the platform username
    X-Gateway-Secret   a secret shared only between the gateway and this tool

The gateway strips any client-supplied copies before setting its own, so a
browser cannot spoof them. The secret additionally proves the request came
from the gateway rather than from some other container on the network.

The user is mirrored into the local database on each request so that track
ownership (uploader) keeps working with the existing schema.
"""

import hmac

from fastapi import Depends, Header, HTTPException, status

from . import db
from .config import settings


class CurrentUser:
    def __init__(self, id: int, username: str):
        self.id = id
        self.username = username


def _from_gateway(secret: str | None) -> bool:
    if not secret:
        return False
    return hmac.compare_digest(secret.encode(), settings.gateway_secret.encode())


def optional_session(
    x_auth_user_id: str | None = Header(default=None),
    x_auth_username: str | None = Header(default=None),
    x_gateway_secret: str | None = Header(default=None),
) -> CurrentUser | None:
    """The signed-in user, or None for anonymous requests (e.g. a share link
    opened by someone without an account)."""
    if not _from_gateway(x_gateway_secret) or not x_auth_user_id or not x_auth_username:
        return None
    try:
        return CurrentUser(id=int(x_auth_user_id), username=x_auth_username)
    except ValueError:
        return None


def require_session(user: CurrentUser | None = Depends(optional_session)) -> CurrentUser:
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    # Keep a local mirror of the platform account so uploader joins resolve.
    db.upsert_user(user.id, user.username)
    return user
