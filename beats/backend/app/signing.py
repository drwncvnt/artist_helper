from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from .config import settings

_track_signer = URLSafeTimedSerializer(settings.signing_secret, salt="beats-track")


def sign_track(track_id: str) -> str:
    """Returns an opaque, time-limited share token for a given track id."""
    return _track_signer.dumps({"t": track_id})


def track_id_from_token(token: str) -> str | None:
    """Returns the track id a token was issued for, or None if it is invalid or
    expired. Used by the public share / listen endpoints."""
    try:
        data = _track_signer.loads(token, max_age=settings.share_ttl_seconds)
    except (BadSignature, SignatureExpired):
        return None
    return data.get("t")


def verify_track_token(token: str, track_id: str) -> bool:
    return track_id_from_token(token) == track_id
