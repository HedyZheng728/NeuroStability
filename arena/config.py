import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def workspace_today(timezone_name="Asia/Shanghai", *, instant=None):
    """Calendar day in the workspace, independent of the server's local timezone."""
    instant = instant if instant is not None else datetime.now(timezone.utc)
    if instant.tzinfo is None or instant.utcoffset() is None:
        raise ValueError("Workspace time requires a timezone-aware instant")
    return instant.astimezone(ZoneInfo(timezone_name)).date()


@dataclass
class Settings:
    data_dir: Path = field(default_factory=lambda: Path(os.getenv("ARENA_DATA_DIR", "data")).resolve())
    database_url: str = field(default_factory=lambda: os.getenv("DATABASE_URL", ""))
    production: bool = field(default_factory=lambda: os.getenv("ARENA_ENV") == "production")
    public_url: str = field(default_factory=lambda: os.getenv("ARENA_PUBLIC_URL", "http://127.0.0.1:8000").rstrip("/"))
    admin_password: str = field(default_factory=lambda: os.getenv("ARENA_ADMIN_PASSWORD", ""))
    timezone: str = field(default_factory=lambda: os.getenv("ARENA_TIMEZONE", "Asia/Shanghai"))
    max_upload_bytes: int = 100 * 1024 * 1024
    max_video_seconds: int = 300
    sample_fps: int = 10
    sample_enabled: bool = field(default_factory=lambda: os.getenv("ARENA_ENABLE_SAMPLE", "true").lower() == "true")
    bucket: str = field(default_factory=lambda: os.getenv("S3_BUCKET", ""))
    s3_endpoint: str = field(default_factory=lambda: os.getenv("S3_ENDPOINT_URL", ""))
    s3_region: str = field(default_factory=lambda: os.getenv("AWS_DEFAULT_REGION", "auto"))
    detector_path: str = field(default_factory=lambda: os.getenv("RTMPOSE_DETECTOR", ""))
    pose_path: str = field(default_factory=lambda: os.getenv("RTMPOSE_MODEL", ""))
    sam2_path: str = field(default_factory=lambda: os.getenv("SAM2_MODEL_DIR", ""))
    fsw_bundle: str = field(default_factory=lambda: os.getenv("FSW_BUNDLE", ""))
    action_model_path: str = field(default_factory=lambda: os.getenv("ARENA_ACTION_MODEL_DIR", ""))
    pose3d_model_path: str = field(default_factory=lambda: os.getenv("ARENA_POSE3D_MODEL", ""))
    review_model_path: str = field(default_factory=lambda: os.getenv("ARENA_REVIEW_MODEL_DIR", ""))
    llm_base_url: str = field(default_factory=lambda: os.getenv("LLM_BASE_URL", ""))
    llm_model: str = field(default_factory=lambda: os.getenv("LLM_MODEL", ""))
    llm_key: str = field(default_factory=lambda: os.getenv("LLM_API_KEY", ""))

    def validate(self):
        try:
            ZoneInfo(self.timezone)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError("ARENA_TIMEZONE 须为有效 IANA 时区，例如 Asia/Shanghai") from exc
        self.data_dir.mkdir(parents=True, exist_ok=True)
        if not self.database_url:
            self.database_url = f"sqlite:///{self.data_dir / 'arena.db'}"
        if self.database_url.startswith("postgres://"):
            self.database_url = self.database_url.replace("postgres://", "postgresql+psycopg://", 1)
        if self.database_url.startswith("postgresql://"):
            self.database_url = self.database_url.replace("postgresql://", "postgresql+psycopg://", 1)
        if len(self.admin_password) < 16:
            raise ValueError("请设置至少16位 ARENA_ADMIN_PASSWORD；禁止使用默认线上密码")
        if self.production:
            if not self.public_url.startswith("https://"):
                raise ValueError("线上必须设置 HTTPS ARENA_PUBLIC_URL")
            if not self.database_url.startswith("postgresql+") or not self.bucket:
                raise ValueError("线上必须配置 PostgreSQL DATABASE_URL 和私有 S3_BUCKET")
