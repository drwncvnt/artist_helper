from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Secret used to sign time-limited track streaming tokens. Provided by the
    # platform environment. User accounts and login now live in the central
    # accounts service, so there is no session/password secret here anymore.
    signing_secret: str
    # Shared with the gateway only. Requests carrying identity headers must
    # also carry this secret, so another container on the network can't
    # impersonate a user by sending X-Auth-User-Id itself.
    gateway_secret: str
    # Lifetime of a public share link. Long by default - share links are meant to
    # be sent to people (a label, a friend) and stay valid for a while.
    share_ttl_seconds: int = 7776000  # 90 days

    storage_dir: str = "/data/storage"
    db_dir: str = "/data/db"

    # Upload size cap in megabytes.
    max_upload_mb: int = 200
    # Total storage one account may use, in megabytes.
    user_quota_mb: int = 1024
    # Uploads are refused when the storage volume would drop below this much
    # free space, so the platform can never fill the host disk.
    min_free_disk_mb: int = 10240

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    @property
    def user_quota_bytes(self) -> int:
        return self.user_quota_mb * 1024 * 1024

    @property
    def min_free_disk_bytes(self) -> int:
        return self.min_free_disk_mb * 1024 * 1024


settings = Settings()
