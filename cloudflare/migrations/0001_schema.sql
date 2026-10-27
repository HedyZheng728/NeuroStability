-- Original SQLite schema; additive cloud-only tables follow.

PRAGMA foreign_keys=ON;

CREATE TABLE athletes (
	id VARCHAR(36) NOT NULL,
	name VARCHAR(100) NOT NULL,
	level VARCHAR(100) NOT NULL,
	created_at VARCHAR(40) NOT NULL,
	PRIMARY KEY (id)
);

CREATE TABLE login_attempts (
	id VARCHAR(36) NOT NULL,
	client VARCHAR(64),
	created BIGINT,
	PRIMARY KEY (id)
);

CREATE INDEX ix_login_attempts_client ON login_attempts (client);

CREATE TABLE schema_version (
	version INTEGER NOT NULL,
	PRIMARY KEY (version)
);

CREATE TABLE users (
	id VARCHAR(36) NOT NULL,
	username VARCHAR(80) NOT NULL,
	password_hash TEXT NOT NULL,
	PRIMARY KEY (id),
	UNIQUE (username)
);

CREATE TABLE auth_sessions (
	id VARCHAR(64) NOT NULL,
	user_id VARCHAR(36) NOT NULL,
	csrf VARCHAR(80) NOT NULL,
	expires BIGINT NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE sessions (
	id VARCHAR(36) NOT NULL,
	athlete_id VARCHAR(36) NOT NULL,
	date VARCHAR(10) NOT NULL,
	objective TEXT NOT NULL,
	duration_min INTEGER NOT NULL,
	rpe INTEGER,
	notes TEXT NOT NULL,
	created_at VARCHAR(40) NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(athlete_id) REFERENCES athletes (id) ON DELETE CASCADE
);

CREATE INDEX ix_sessions_athlete_id ON sessions (athlete_id);

CREATE TABLE training_plans (
	id VARCHAR(36) NOT NULL,
	athlete_id VARCHAR(36) NOT NULL,
	date VARCHAR(10) NOT NULL,
	category VARCHAR(20) NOT NULL,
	objective TEXT NOT NULL,
	planned_minutes INTEGER NOT NULL,
	status VARCHAR(20) NOT NULL,
	session_id VARCHAR(36),
	created_at VARCHAR(40) NOT NULL,
	PRIMARY KEY (id),
	CHECK (planned_minutes BETWEEN 1 AND 1440),
	CHECK (status IN ('planned', 'cancelled')),
	CHECK (category IN ('stability', 'footwork', 'attack', 'defense')),
	CHECK (session_id IS NULL OR status = 'planned'),
	FOREIGN KEY(athlete_id) REFERENCES athletes (id) ON DELETE CASCADE,
	UNIQUE (session_id),
	FOREIGN KEY(session_id) REFERENCES sessions (id) ON DELETE SET NULL
);

CREATE INDEX ix_training_plans_athlete_id ON training_plans (athlete_id);

CREATE INDEX ix_training_plans_date ON training_plans (date);

CREATE TABLE videos (
	id VARCHAR(36) NOT NULL,
	session_id VARCHAR(36) NOT NULL,
	category VARCHAR(20) NOT NULL,
	filename VARCHAR(200) NOT NULL,
	storage_key TEXT NOT NULL,
	sha256 VARCHAR(64) NOT NULL,
	size_bytes BIGINT NOT NULL,
	status VARCHAR(30) NOT NULL,
	authorized_at VARCHAR(40) NOT NULL,
	created_at VARCHAR(40) NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(session_id) REFERENCES sessions (id) ON DELETE CASCADE
);

CREATE INDEX ix_videos_session_id ON videos (session_id);

CREATE TABLE jobs (
	id VARCHAR(36) NOT NULL,
	video_id VARCHAR(36) NOT NULL,
	backend VARCHAR(30) NOT NULL,
	status VARCHAR(30) NOT NULL,
	stage VARCHAR(100) NOT NULL,
	progress INTEGER NOT NULL,
	params JSON NOT NULL,
	metadata JSON,
	result JSON,
	error TEXT,
	lease_until BIGINT,
	worker_token VARCHAR(36),
	created_at VARCHAR(40) NOT NULL,
	updated_at VARCHAR(40) NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(video_id) REFERENCES videos (id) ON DELETE CASCADE
);

CREATE INDEX ix_jobs_status ON jobs (status);

CREATE INDEX ix_jobs_video_id ON jobs (video_id);

CREATE UNIQUE INDEX one_active_job_per_video ON jobs (video_id) WHERE status IN ('queued', 'running');

CREATE TABLE manual_scores (
	id VARCHAR(36) NOT NULL,
	video_id VARCHAR(36) NOT NULL,
	score FLOAT NOT NULL,
	comment TEXT NOT NULL,
	confirmed BOOLEAN NOT NULL,
	assessor VARCHAR(80) NOT NULL,
	rubric_version VARCHAR(80) NOT NULL,
	updated_at VARCHAR(40) NOT NULL,
	PRIMARY KEY (id),
	CHECK (score BETWEEN 0 AND 10),
	CHECK (NOT confirmed OR length(trim(comment)) > 0),
	UNIQUE (video_id),
	FOREIGN KEY(video_id) REFERENCES videos (id) ON DELETE CASCADE
);

CREATE TABLE review_history (
	id VARCHAR(36) NOT NULL,
	video_id VARCHAR(36) NOT NULL,
	snapshot JSON NOT NULL,
	created_at VARCHAR(40) NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(video_id) REFERENCES videos (id) ON DELETE CASCADE
);

CREATE TABLE score_history (
	id VARCHAR(36) NOT NULL,
	video_id VARCHAR(36) NOT NULL,
	snapshot JSON NOT NULL,
	created_at VARCHAR(40) NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(video_id) REFERENCES videos (id) ON DELETE CASCADE
);

CREATE INDEX ix_score_history_video_id ON score_history (video_id);

CREATE TABLE analysis_assessment_history (
	id VARCHAR(36) NOT NULL,
	job_id VARCHAR(36) NOT NULL,
	snapshot JSON NOT NULL,
	created_at VARCHAR(40) NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(job_id) REFERENCES jobs (id) ON DELETE CASCADE
);

CREATE INDEX ix_analysis_assessment_history_job_id ON analysis_assessment_history (job_id);

CREATE TABLE analysis_assessments (
	id VARCHAR(36) NOT NULL,
	job_id VARCHAR(36) NOT NULL,
	decision VARCHAR(20) NOT NULL,
	subject_role VARCHAR(20) NOT NULL,
	reason TEXT NOT NULL,
	reviewer VARCHAR(80) NOT NULL,
	updated_at VARCHAR(40) NOT NULL,
	PRIMARY KEY (id),
	CHECK (decision IN ('accepted', 'excluded', 'superseded', 'pending')),
	CHECK (subject_role IN ('athlete', 'coach', 'unknown')),
	CHECK (decision = 'pending' OR length(trim(reason)) > 0),
	UNIQUE (job_id),
	FOREIGN KEY(job_id) REFERENCES jobs (id) ON DELETE CASCADE
);

CREATE TABLE events (
	id VARCHAR(36) NOT NULL,
	video_id VARCHAR(36) NOT NULL,
	source_job_id VARCHAR(36),
	start_sec FLOAT NOT NULL,
	end_sec FLOAT NOT NULL,
	label VARCHAR(100) NOT NULL,
	actor VARCHAR(20) NOT NULL,
	outcome VARCHAR(100) NOT NULL,
	notes TEXT NOT NULL,
	created_by VARCHAR(80) NOT NULL,
	created_at VARCHAR(40) NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(video_id) REFERENCES videos (id) ON DELETE CASCADE,
	FOREIGN KEY(source_job_id) REFERENCES jobs (id) ON DELETE SET NULL
);

CREATE INDEX ix_events_video_id ON events (video_id);

CREATE TABLE review_drafts (
	id VARCHAR(36) NOT NULL,
	video_id VARCHAR(36) NOT NULL,
	job_id VARCHAR(36) NOT NULL,
	provider VARCHAR(40) NOT NULL,
	model VARCHAR(100) NOT NULL,
	synthetic BOOLEAN NOT NULL,
	text TEXT NOT NULL,
	facts JSON NOT NULL,
	created_at VARCHAR(40) NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(video_id) REFERENCES videos (id) ON DELETE CASCADE,
	FOREIGN KEY(job_id) REFERENCES jobs (id) ON DELETE CASCADE
);

CREATE TABLE reviews (
	id VARCHAR(36) NOT NULL,
	video_id VARCHAR(36) NOT NULL,
	draft_id VARCHAR(36),
	observations TEXT NOT NULL,
	next_action TEXT NOT NULL,
	confirmed BOOLEAN NOT NULL,
	confirmed_by VARCHAR(80),
	updated_at VARCHAR(40) NOT NULL,
	PRIMARY KEY (id),
	UNIQUE (video_id),
	FOREIGN KEY(video_id) REFERENCES videos (id) ON DELETE CASCADE,
	FOREIGN KEY(draft_id) REFERENCES review_drafts (id) ON DELETE SET NULL
);

CREATE TABLE worker_capabilities (worker_id TEXT PRIMARY KEY, models TEXT NOT NULL, last_seen INTEGER NOT NULL);

CREATE TABLE uploads (id TEXT PRIMARY KEY, video_id TEXT, storage_key TEXT, multipart_id TEXT, payload TEXT NOT NULL, expires INTEGER NOT NULL);

CREATE TABLE login_challenges (id TEXT PRIMARY KEY, username TEXT NOT NULL, nonce TEXT NOT NULL, expires INTEGER NOT NULL);

CREATE TABLE worker_completions (job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE, worker_token TEXT NOT NULL, payload_sha256 TEXT NOT NULL, response TEXT NOT NULL);

CREATE TABLE job_artifacts (job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, name TEXT NOT NULL, storage_key TEXT NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, worker_token TEXT NOT NULL, PRIMARY KEY(job_id,name,worker_token));

CREATE TABLE artifact_uploads (id TEXT PRIMARY KEY, job_id TEXT, worker_token TEXT, name TEXT, storage_key TEXT, multipart_id TEXT, expires INTEGER NOT NULL, payload TEXT NOT NULL);

CREATE TABLE cloud_migrations (id TEXT PRIMARY KEY, manifest_sha256 TEXT NOT NULL, imported_at TEXT NOT NULL, table_counts TEXT NOT NULL);
