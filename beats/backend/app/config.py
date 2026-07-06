from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Secret used to sign time-limited track streaming tokens. Provided by the
    # platform environment. User accounts and login now live in the central
    # accounts service, so there is no session/password secret here anymore.
    signing_secret: str
    # Lifetime of a public share link. Long by default - share links are meant to
    # be sent to people (a label, a friend) and stay valid for a while.
    share_ttl_seconds: int = 7776000  # 90 days

    storage_dir: str = "/data/storage"
    db_dir: str = "/data/db"

    # Upload size cap in megabytes.
    max_upload_mb: int = 200

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024


settings = Settings()
