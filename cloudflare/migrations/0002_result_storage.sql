-- JSON result bytes only. Published keys point to complete, verified upload versions.
CREATE TABLE IF NOT EXISTS result_objects (
    key TEXT PRIMARY KEY,
    upload_id TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 16777216),
    sha256 TEXT NOT NULL,
    metadata TEXT NOT NULL,
    uploaded TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS result_uploads (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    metadata TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'open',
    finalize_token TEXT,
    finalize_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS result_uploads_key ON result_uploads(key);
CREATE TABLE IF NOT EXISTS result_parts (
    upload_id TEXT NOT NULL,
    part_number INTEGER NOT NULL,
    size_bytes INTEGER NOT NULL,
    etag TEXT NOT NULL,
    PRIMARY KEY(upload_id,part_number)
);
CREATE TABLE IF NOT EXISTS result_chunks (
    upload_id TEXT NOT NULL,
    part_number INTEGER NOT NULL,
    chunk_number INTEGER NOT NULL,
    data TEXT NOT NULL CHECK(length(data)<=262144),
    PRIMARY KEY(upload_id,part_number,chunk_number)
);
