-- Revisions cover every original record; DELETE retains a tombstone for safe reconciliation.

CREATE TABLE sync_versions (table_name TEXT NOT NULL, record_key TEXT NOT NULL, revision TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(table_name,record_key));

INSERT INTO sync_versions SELECT 'schema_version', CAST(version AS TEXT), lower(hex(randomblob(16))), 0 FROM schema_version;

CREATE TRIGGER sync_schema_version_insert AFTER INSERT ON schema_version BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('schema_version',CAST(NEW.version AS TEXT),lower(hex(randomblob(16))),0) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

CREATE TRIGGER sync_schema_version_update AFTER UPDATE ON schema_version BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) SELECT 'schema_version',CAST(OLD.version AS TEXT),lower(hex(randomblob(16))),1 WHERE OLD.version != NEW.version ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=1; INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('schema_version',CAST(NEW.version AS TEXT),lower(hex(randomblob(16))),0) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

CREATE TRIGGER sync_schema_version_delete AFTER DELETE ON schema_version BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('schema_version',CAST(OLD.version AS TEXT),lower(hex(randomblob(16))),1) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

INSERT INTO sync_versions SELECT 'users', CAST(id AS TEXT), lower(hex(randomblob(16))), 0 FROM users;

CREATE TRIGGER sync_users_insert AFTER INSERT ON users BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('users',CAST(NEW.id AS TEXT),lower(hex(randomblob(16))),0) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

CREATE TRIGGER sync_users_update AFTER UPDATE ON users BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) SELECT 'users',CAST(OLD.id AS TEXT),lower(hex(randomblob(16))),1 WHERE OLD.id != NEW.id ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=1; INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('users',CAST(NEW.id AS TEXT),lower(hex(randomblob(16))),0) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

CREATE TRIGGER sync_users_delete AFTER DELETE ON users BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('users',CAST(OLD.id AS TEXT),lower(hex(randomblob(16))),1) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

INSERT INTO sync_versions SELECT 'athletes', CAST(id AS TEXT), lower(hex(randomblob(16))), 0 FROM athletes;

CREATE TRIGGER sync_athletes_insert AFTER INSERT ON athletes BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('athletes',CAST(NEW.id AS TEXT),lower(hex(randomblob(16))),0) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

CREATE TRIGGER sync_athletes_update AFTER UPDATE ON athletes BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) SELECT 'athletes',CAST(OLD.id AS TEXT),lower(hex(randomblob(16))),1 WHERE OLD.id != NEW.id ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=1; INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('athletes',CAST(NEW.id AS TEXT),lower(hex(randomblob(16))),0) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

CREATE TRIGGER sync_athletes_delete AFTER DELETE ON athletes BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('athletes',CAST(OLD.id AS TEXT),lower(hex(randomblob(16))),1) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

INSERT INTO sync_versions SELECT 'sessions', CAST(id AS TEXT), lower(hex(randomblob(16))), 0 FROM sessions;

CREATE TRIGGER sync_sessions_insert AFTER INSERT ON sessions BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('sessions',CAST(NEW.id AS TEXT),lower(hex(randomblob(16))),0) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

CREATE TRIGGER sync_sessions_update AFTER UPDATE ON sessions BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) SELECT 'sessions',CAST(OLD.id AS TEXT),lower(hex(randomblob(16))),1 WHERE OLD.id != NEW.id ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=1; INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('sessions',CAST(NEW.id AS TEXT),lower(hex(randomblob(16))),0) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

CREATE TRIGGER sync_sessions_delete AFTER DELETE ON sessions BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('sessions',CAST(OLD.id AS TEXT),lower(hex(randomblob(16))),1) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

INSERT INTO sync_versions SELECT 'training_plans', CAST(id AS TEXT), lower(hex(randomblob(16))), 0 FROM training_plans;

CREATE TRIGGER sync_training_plans_insert AFTER INSERT ON training_plans BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('training_plans',CAST(NEW.id AS TEXT),lower(hex(randomblob(16))),0) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

CREATE TRIGGER sync_training_plans_update AFTER UPDATE ON training_plans BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) SELECT 'training_plans',CAST(OLD.id AS TEXT),lower(hex(randomblob(16))),1 WHERE OLD.id != NEW.id ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=1; INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('training_plans',CAST(NEW.id AS TEXT),lower(hex(randomblob(16))),0) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

CREATE TRIGGER sync_training_plans_delete AFTER DELETE ON training_plans BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('training_plans',CAST(OLD.id AS TEXT),lower(hex(randomblob(16))),1) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

INSERT INTO sync_versions SELECT 'videos', CAST(id AS TEXT), lower(hex(randomblob(16))), 0 FROM videos;

CREATE TRIGGER sync_videos_insert AFTER INSERT ON videos BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('videos',CAST(NEW.id AS TEXT),lower(hex(randomblob(16))),0) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

CREATE TRIGGER sync_videos_update AFTER UPDATE ON videos BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) SELECT 'videos',CAST(OLD.id AS TEXT),lower(hex(randomblob(16))),1 WHERE OLD.id != NEW.id ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=1; INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('videos',CAST(NEW.id AS TEXT),lower(hex(randomblob(16))),0) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

CREATE TRIGGER sync_videos_delete AFTER DELETE ON videos BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('videos',CAST(OLD.id AS TEXT),lower(hex(randomblob(16))),1) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

INSERT INTO sync_versions SELECT 'jobs', CAST(id AS TEXT), lower(hex(randomblob(16))), 0 FROM jobs;

CREATE TRIGGER sync_jobs_insert AFTER INSERT ON jobs BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('jobs',CAST(NEW.id AS TEXT),lower(hex(randomblob(16))),0) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

CREATE TRIGGER sync_jobs_update AFTER UPDATE ON jobs BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) SELECT 'jobs',CAST(OLD.id AS TEXT),lower(hex(randomblob(16))),1 WHERE OLD.id != NEW.id ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=1; INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('jobs',CAST(NEW.id AS TEXT),lower(hex(randomblob(16))),0) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

CREATE TRIGGER sync_jobs_delete AFTER DELETE ON jobs BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('jobs',CAST(OLD.id AS TEXT),lower(hex(randomblob(16))),1) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

INSERT INTO sync_versions SELECT 'review_drafts', CAST(id AS TEXT), lower(hex(randomblob(16))), 0 FROM review_drafts;

CREATE TRIGGER sync_review_drafts_insert AFTER INSERT ON review_drafts BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('review_drafts',CAST(NEW.id AS TEXT),lower(hex(randomblob(16))),0) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

CREATE TRIGGER sync_review_drafts_update AFTER UPDATE ON review_drafts BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) SELECT 'review_drafts',CAST(OLD.id AS TEXT),lower(hex(randomblob(16))),1 WHERE OLD.id != NEW.id ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=1; INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('review_drafts',CAST(NEW.id AS TEXT),lower(hex(randomblob(16))),0) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

CREATE TRIGGER sync_review_drafts_delete AFTER DELETE ON review_drafts BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('review_drafts',CAST(OLD.id AS TEXT),lower(hex(randomblob(16))),1) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

INSERT INTO sync_versions SELECT 'reviews', CAST(id AS TEXT), lower(hex(randomblob(16))), 0 FROM reviews;

CREATE TRIGGER sync_reviews_insert AFTER INSERT ON reviews BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('reviews',CAST(NEW.id AS TEXT),lower(hex(randomblob(16))),0) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

CREATE TRIGGER sync_reviews_update AFTER UPDATE ON reviews BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) SELECT 'reviews',CAST(OLD.id AS TEXT),lower(hex(randomblob(16))),1 WHERE OLD.id != NEW.id ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=1; INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('reviews',CAST(NEW.id AS TEXT),lower(hex(randomblob(16))),0) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

CREATE TRIGGER sync_reviews_delete AFTER DELETE ON reviews BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('reviews',CAST(OLD.id AS TEXT),lower(hex(randomblob(16))),1) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

INSERT INTO sync_versions SELECT 'review_history', CAST(id AS TEXT), lower(hex(randomblob(16))), 0 FROM review_history;

CREATE TRIGGER sync_review_history_insert AFTER INSERT ON review_history BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('review_history',CAST(NEW.id AS TEXT),lower(hex(randomblob(16))),0) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

CREATE TRIGGER sync_review_history_update AFTER UPDATE ON review_history BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) SELECT 'review_history',CAST(OLD.id AS TEXT),lower(hex(randomblob(16))),1 WHERE OLD.id != NEW.id ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=1; INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('review_history',CAST(NEW.id AS TEXT),lower(hex(randomblob(16))),0) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

CREATE TRIGGER sync_review_history_delete AFTER DELETE ON review_history BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('review_history',CAST(OLD.id AS TEXT),lower(hex(randomblob(16))),1) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

INSERT INTO sync_versions SELECT 'manual_scores', CAST(id AS TEXT), lower(hex(randomblob(16))), 0 FROM manual_scores;

CREATE TRIGGER sync_manual_scores_insert AFTER INSERT ON manual_scores BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('manual_scores',CAST(NEW.id AS TEXT),lower(hex(randomblob(16))),0) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

CREATE TRIGGER sync_manual_scores_update AFTER UPDATE ON manual_scores BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) SELECT 'manual_scores',CAST(OLD.id AS TEXT),lower(hex(randomblob(16))),1 WHERE OLD.id != NEW.id ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=1; INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('manual_scores',CAST(NEW.id AS TEXT),lower(hex(randomblob(16))),0) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

CREATE TRIGGER sync_manual_scores_delete AFTER DELETE ON manual_scores BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('manual_scores',CAST(OLD.id AS TEXT),lower(hex(randomblob(16))),1) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

INSERT INTO sync_versions SELECT 'score_history', CAST(id AS TEXT), lower(hex(randomblob(16))), 0 FROM score_history;

CREATE TRIGGER sync_score_history_insert AFTER INSERT ON score_history BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('score_history',CAST(NEW.id AS TEXT),lower(hex(randomblob(16))),0) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

CREATE TRIGGER sync_score_history_update AFTER UPDATE ON score_history BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) SELECT 'score_history',CAST(OLD.id AS TEXT),lower(hex(randomblob(16))),1 WHERE OLD.id != NEW.id ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=1; INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('score_history',CAST(NEW.id AS TEXT),lower(hex(randomblob(16))),0) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

CREATE TRIGGER sync_score_history_delete AFTER DELETE ON score_history BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('score_history',CAST(OLD.id AS TEXT),lower(hex(randomblob(16))),1) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

INSERT INTO sync_versions SELECT 'analysis_assessments', CAST(id AS TEXT), lower(hex(randomblob(16))), 0 FROM analysis_assessments;

CREATE TRIGGER sync_analysis_assessments_insert AFTER INSERT ON analysis_assessments BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('analysis_assessments',CAST(NEW.id AS TEXT),lower(hex(randomblob(16))),0) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

CREATE TRIGGER sync_analysis_assessments_update AFTER UPDATE ON analysis_assessments BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) SELECT 'analysis_assessments',CAST(OLD.id AS TEXT),lower(hex(randomblob(16))),1 WHERE OLD.id != NEW.id ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=1; INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('analysis_assessments',CAST(NEW.id AS TEXT),lower(hex(randomblob(16))),0) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

CREATE TRIGGER sync_analysis_assessments_delete AFTER DELETE ON analysis_assessments BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('analysis_assessments',CAST(OLD.id AS TEXT),lower(hex(randomblob(16))),1) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

INSERT INTO sync_versions SELECT 'analysis_assessment_history', CAST(id AS TEXT), lower(hex(randomblob(16))), 0 FROM analysis_assessment_history;

CREATE TRIGGER sync_analysis_assessment_history_insert AFTER INSERT ON analysis_assessment_history BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('analysis_assessment_history',CAST(NEW.id AS TEXT),lower(hex(randomblob(16))),0) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

CREATE TRIGGER sync_analysis_assessment_history_update AFTER UPDATE ON analysis_assessment_history BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) SELECT 'analysis_assessment_history',CAST(OLD.id AS TEXT),lower(hex(randomblob(16))),1 WHERE OLD.id != NEW.id ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=1; INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('analysis_assessment_history',CAST(NEW.id AS TEXT),lower(hex(randomblob(16))),0) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

CREATE TRIGGER sync_analysis_assessment_history_delete AFTER DELETE ON analysis_assessment_history BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('analysis_assessment_history',CAST(OLD.id AS TEXT),lower(hex(randomblob(16))),1) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

INSERT INTO sync_versions SELECT 'events', CAST(id AS TEXT), lower(hex(randomblob(16))), 0 FROM events;

CREATE TRIGGER sync_events_insert AFTER INSERT ON events BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('events',CAST(NEW.id AS TEXT),lower(hex(randomblob(16))),0) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

CREATE TRIGGER sync_events_update AFTER UPDATE ON events BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) SELECT 'events',CAST(OLD.id AS TEXT),lower(hex(randomblob(16))),1 WHERE OLD.id != NEW.id ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=1; INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('events',CAST(NEW.id AS TEXT),lower(hex(randomblob(16))),0) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;

CREATE TRIGGER sync_events_delete AFTER DELETE ON events BEGIN INSERT INTO sync_versions(table_name,record_key,revision,deleted) VALUES('events',CAST(OLD.id AS TEXT),lower(hex(randomblob(16))),1) ON CONFLICT(table_name,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted; END;
