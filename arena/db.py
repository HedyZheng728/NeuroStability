import hashlib
import secrets
from datetime import datetime, timezone

from sqlalchemy import (BigInteger, Boolean, CheckConstraint, Column, Float, ForeignKey, Index, Integer, JSON,
                        MetaData, String, Table, Text, create_engine, event, insert, inspect, select, update)

meta = MetaData()
schema = Table("schema_version", meta, Column("version", Integer, primary_key=True))
users = Table("users", meta, Column("id", String(36), primary_key=True),
              Column("username", String(80), unique=True, nullable=False), Column("password_hash", Text, nullable=False))
tokens = Table("auth_sessions", meta, Column("id", String(64), primary_key=True),
               Column("user_id", ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
               Column("csrf", String(80), nullable=False), Column("expires", BigInteger, nullable=False))
attempts = Table("login_attempts", meta, Column("id", String(36), primary_key=True),
                 Column("client", String(64), index=True), Column("created", BigInteger))
athletes = Table("athletes", meta, Column("id", String(36), primary_key=True),
                 Column("name", String(100), nullable=False), Column("level", String(100), nullable=False),
                 Column("created_at", String(40), nullable=False))
sessions = Table("sessions", meta, Column("id", String(36), primary_key=True),
                 Column("athlete_id", ForeignKey("athletes.id", ondelete="CASCADE"), nullable=False, index=True),
                 Column("date", String(10), nullable=False), Column("objective", Text, nullable=False),
                 Column("duration_min", Integer, nullable=False), Column("rpe", Integer),
                 Column("notes", Text, nullable=False), Column("created_at", String(40), nullable=False))
plans = Table("training_plans", meta, Column("id", String(36), primary_key=True),
              Column("athlete_id", ForeignKey("athletes.id", ondelete="CASCADE"), nullable=False, index=True),
              Column("date", String(10), nullable=False, index=True), Column("category", String(20), nullable=False),
              Column("objective", Text, nullable=False), Column("planned_minutes", Integer, nullable=False),
              Column("status", String(20), nullable=False),
              Column("session_id", ForeignKey("sessions.id", ondelete="SET NULL"), unique=True),
              Column("created_at", String(40), nullable=False),
              CheckConstraint("planned_minutes BETWEEN 1 AND 1440"),
              CheckConstraint("status IN ('planned', 'cancelled')"),
              CheckConstraint("category IN ('stability', 'footwork', 'attack', 'defense')"),
              CheckConstraint("session_id IS NULL OR status = 'planned'"))
videos = Table("videos", meta, Column("id", String(36), primary_key=True),
               Column("session_id", ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False, index=True),
               Column("category", String(20), nullable=False), Column("filename", String(200), nullable=False),
               Column("storage_key", Text, nullable=False), Column("sha256", String(64), nullable=False),
               Column("size_bytes", BigInteger, nullable=False), Column("status", String(30), nullable=False),
               Column("authorized_at", String(40), nullable=False), Column("created_at", String(40), nullable=False))
jobs = Table("jobs", meta, Column("id", String(36), primary_key=True),
             Column("video_id", ForeignKey("videos.id", ondelete="CASCADE"), nullable=False, index=True),
             Column("backend", String(30), nullable=False), Column("status", String(30), nullable=False, index=True),
             Column("stage", String(100), nullable=False), Column("progress", Integer, nullable=False),
             Column("params", JSON, nullable=False), Column("metadata", JSON), Column("result", JSON),
             Column("error", Text), Column("lease_until", BigInteger), Column("worker_token", String(36)),
             Column("created_at", String(40), nullable=False), Column("updated_at", String(40), nullable=False))
Index("one_active_job_per_video", jobs.c.video_id, unique=True,
      sqlite_where=jobs.c.status.in_(["queued", "running"]),
      postgresql_where=jobs.c.status.in_(["queued", "running"]))
analysis_assessments = Table("analysis_assessments", meta, Column("id", String(36), primary_key=True),
                            Column("job_id", ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False, unique=True),
                            Column("decision", String(20), nullable=False), Column("subject_role", String(20), nullable=False),
                            Column("reason", Text, nullable=False), Column("reviewer", String(80), nullable=False),
                            Column("updated_at", String(40), nullable=False),
                            CheckConstraint("decision IN ('accepted', 'excluded', 'superseded', 'pending')"),
                            CheckConstraint("subject_role IN ('athlete', 'coach', 'unknown')"),
                            CheckConstraint("decision = 'pending' OR length(trim(reason)) > 0"))
analysis_assessment_history = Table("analysis_assessment_history", meta, Column("id", String(36), primary_key=True),
                                   Column("job_id", ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False, index=True),
                                   Column("snapshot", JSON, nullable=False), Column("created_at", String(40), nullable=False))
drafts = Table("review_drafts", meta, Column("id", String(36), primary_key=True),
               Column("video_id", ForeignKey("videos.id", ondelete="CASCADE"), nullable=False),
               Column("job_id", ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False),
               Column("provider", String(40), nullable=False), Column("model", String(100), nullable=False),
               Column("synthetic", Boolean, nullable=False), Column("text", Text, nullable=False),
               Column("facts", JSON, nullable=False), Column("created_at", String(40), nullable=False))
reviews = Table("reviews", meta, Column("id", String(36), primary_key=True),
                Column("video_id", ForeignKey("videos.id", ondelete="CASCADE"), nullable=False, unique=True),
                Column("draft_id", ForeignKey("review_drafts.id", ondelete="SET NULL")),
                Column("observations", Text, nullable=False), Column("next_action", Text, nullable=False),
                Column("confirmed", Boolean, nullable=False), Column("confirmed_by", String(80)),
                Column("updated_at", String(40), nullable=False))
review_history = Table("review_history", meta, Column("id", String(36), primary_key=True),
                       Column("video_id", ForeignKey("videos.id", ondelete="CASCADE"), nullable=False),
                       Column("snapshot", JSON, nullable=False), Column("created_at", String(40), nullable=False))
MANUAL_SCORE_RUBRIC = "training-review-10-v1"
manual_scores = Table("manual_scores", meta, Column("id", String(36), primary_key=True),
                      Column("video_id", ForeignKey("videos.id", ondelete="CASCADE"), nullable=False, unique=True),
                      Column("score", Float, nullable=False), Column("comment", Text, nullable=False),
                      Column("confirmed", Boolean, nullable=False), Column("assessor", String(80), nullable=False),
                      Column("rubric_version", String(80), nullable=False), Column("updated_at", String(40), nullable=False),
                      CheckConstraint("score BETWEEN 0 AND 10"),
                      CheckConstraint("NOT confirmed OR length(trim(comment)) > 0"))
score_history = Table("score_history", meta, Column("id", String(36), primary_key=True),
                      Column("video_id", ForeignKey("videos.id", ondelete="CASCADE"), nullable=False, index=True),
                      Column("snapshot", JSON, nullable=False), Column("created_at", String(40), nullable=False))
events = Table("events", meta, Column("id", String(36), primary_key=True),
               Column("video_id", ForeignKey("videos.id", ondelete="CASCADE"), nullable=False, index=True),
               Column("source_job_id", ForeignKey("jobs.id", ondelete="SET NULL")),
               Column("start_sec", Float, nullable=False), Column("end_sec", Float, nullable=False),
               Column("label", String(100), nullable=False), Column("actor", String(20), nullable=False),
               Column("outcome", String(100), nullable=False), Column("notes", Text, nullable=False),
               Column("created_by", String(80), nullable=False), Column("created_at", String(40), nullable=False))


def now():
    return datetime.now(timezone.utc).isoformat()


def password_hash(password, salt=None):
    salt = salt or secrets.token_hex(16)
    return salt + ":" + hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 260000).hex()


class Database:
    def __init__(self, settings):
        options = {"check_same_thread": False, "timeout": 30} if settings.database_url.startswith("sqlite") else {}
        self.engine = create_engine(settings.database_url, connect_args=options, pool_pre_ping=True)
        if self.engine.dialect.name == "sqlite":
            @event.listens_for(self.engine, "connect")
            def pragmas(connection, _):
                connection.execute("PRAGMA foreign_keys=ON")
                connection.execute("PRAGMA journal_mode=WAL")

    def initialize(self, password):
        with self.engine.begin() as c:
            if self.engine.dialect.name == "postgresql":
                c.exec_driver_sql("SELECT pg_advisory_xact_lock(20371026)")
            version = c.execute(select(schema.c.version)).scalar() if inspect(c).has_table(schema.name) else None
            if version not in (None, 1, 2, 3, 4):
                raise RuntimeError("数据库版本不兼容，需要迁移")
            # v2 adds planning/scores; v3 adds per-analysis decisions and history.
            # v4 adds nullable event provenance; records and credentials remain intact.
            meta.create_all(c)
            if 'source_job_id' not in {column['name'] for column in inspect(c).get_columns('events')}:
                c.exec_driver_sql('ALTER TABLE events ADD COLUMN source_job_id VARCHAR(36) REFERENCES jobs(id) ON DELETE SET NULL')
            if version is None:
                c.execute(insert(schema).values(version=4))
            elif version < 4:
                c.execute(update(schema).where(schema.c.version == version).values(version=4))
            if not c.execute(select(users.c.id)).first():
                c.execute(insert(users).values(id=secrets.token_hex(16), username="admin", password_hash=password_hash(password)))

    def rows(self, stmt):
        with self.engine.connect() as c:
            return [dict(r) for r in c.execute(stmt).mappings()]

    def get(self, table, id):
        rows = self.rows(select(table).where(table.c.id == id))
        return rows[0] if rows else None

    def add(self, table, data):
        with self.engine.begin() as c:
            c.execute(insert(table).values(**data))
        return data
