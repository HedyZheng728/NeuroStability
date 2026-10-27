"""Private, resumable SQLite -> D1 / local objects -> R2 migration.

Export is local only. Import and remote verification require explicit subcommands
and credentials supplied through the environment, never command-line secrets.
"""
import argparse
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import mimetypes
import os
from pathlib import Path, PurePosixPath
import shutil
import sqlite3
import sys
import time
from urllib.parse import quote
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
EXCLUDED = {"auth_sessions", "login_attempts"}
INFRASTRUCTURE = {"cloud_migrations", "d1_migrations", "login_challenges", "worker_capabilities"}


def canonical(value):
    # D1's JSON transport represents integral REAL values as integers. SQLite's
    # declared affinities restore those values; normalize their hash accordingly.
    return json.dumps(canonical_value(value), ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def canonical_value(value):
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, dict):
        return {key: canonical_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [canonical_value(item) for item in value]
    return value


def sha_file(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def identifier(name):
    return '"' + name.replace('"', '""') + '"'


def readonly(path):
    connection = sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro")
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    return connection


def source_signature(path):
    signature = []
    for candidate in (Path(path), Path(str(path) + "-wal")):
        if candidate.exists():
            before = candidate.stat()
            checksum = sha_file(candidate)
            after = candidate.stat()
            if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                raise ValueError("Source database changed while reading; stop local writes and retry")
            signature.append((str(candidate), after.st_size, after.st_mtime_ns, checksum))
    return signature


def object_path(root, key):
    if (not isinstance(key, str) or not key or key.startswith("/") or "\\" in key
            or ".." in PurePosixPath(key).parts or str(PurePosixPath(key)) != key):
        raise ValueError("Unsafe object storage key")
    root = Path(root).resolve()
    path = root / key
    current = root
    for part in PurePosixPath(key).parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("Symlink objects are not allowed")
    if not path.resolve().is_relative_to(root):
        raise ValueError("Object escapes private storage")
    return path


def file_record(root, key):
    path = object_path(root, key)
    if not path.is_file():
        raise ValueError(f"Missing object: {key}")
    before = path.stat()
    checksum = sha_file(path)
    after = path.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError(f"Object changed while hashing: {key}")
    return {"key": key, "source": str(path), "size_bytes": after.st_size, "sha256": checksum}


def table_names(query):
    return sorted(row["name"] for row in query("SELECT name FROM sqlite_master WHERE type='table'")
                  if not row["name"].startswith(("sqlite_", "_cf_")) and row["name"] not in INFRASTRUCTURE)


def snapshot_tables(connection):
    query = lambda sql, params=(): [dict(row) for row in connection.execute(sql, params)]
    selected = set(table_names(query)) - EXCLUDED
    dependencies = {name: {row["table"] for row in query(f"PRAGMA foreign_key_list({identifier(name)})")}
                    & selected for name in selected}
    ordered = []
    while dependencies:
        ready = sorted(name for name, parents in dependencies.items() if not parents)
        if not ready:
            raise ValueError("Cyclic source schema cannot be imported safely")
        ordered.extend(ready)
        dependencies = {name: parents - set(ready) for name, parents in dependencies.items() if name not in ready}
    result = {}
    for name in ordered:
        columns = query(f"PRAGMA table_info({identifier(name)})")
        primary_key = [row["name"] for row in sorted(columns, key=lambda row: row["pk"]) if row["pk"]]
        if not primary_key:
            raise ValueError(f"Table has no primary key: {name}")
        rows = query(f"SELECT * FROM {identifier(name)} ORDER BY {','.join(map(identifier, primary_key))}")
        result[name] = {"columns": [row["name"] for row in columns], "primary_key": primary_key, "rows": rows}
    return result


def summarize(table):
    rows = table["rows"]
    return {"columns": table["columns"], "primary_key": table["primary_key"], "count": len(rows),
            "sha256": hashlib.sha256(canonical(rows)).hexdigest(),
            "row_hashes": [{"key": [row[key] for key in table["primary_key"]],
                            "sha256": hashlib.sha256(canonical(row)).hexdigest()} for row in rows]}


def d1_preflight(tables):
    # D1 limits the entire row to 2,000,000 bytes; leave room for record headers.
    for name, table in tables.items():
        for row in table["rows"]:
            size = sum(len(value.encode("utf-8")) if isinstance(value, str) else 8 for value in row.values())
            if size > 1_900_000:
                raise ValueError(f"D1 row limit exceeded in {name}; source is preserved, no cloud writes were made")


def export_bundle(source_db, objects_root, destination):
    """Read-only backup and manifest; media are hashed in place, never duplicated."""
    source_db, objects_root, destination = Path(source_db).resolve(), Path(objects_root).resolve(), Path(destination).resolve()
    if not source_db.is_file():
        raise ValueError("Source SQLite database does not exist")
    if destination.is_relative_to(objects_root):
        raise ValueError("Bundle must be outside the object storage tree")
    if destination.exists():
        raise ValueError("Export destination already exists; choose a new private directory")
    destination.mkdir(parents=True, mode=0o700)
    destination.chmod(0o700)
    snapshot = destination / "snapshot.sqlite3"
    try:
        before = source_signature(source_db)
        with closing(readonly(source_db)) as source, closing(sqlite3.connect(snapshot)) as target:
            source.backup(target)
            # A standalone backup must not depend on a WAL or create mutable
            # sidecars whenever validation opens it read-only.
            if target.execute("PRAGMA journal_mode=DELETE").fetchone()[0] != "delete":
                raise ValueError("Unable to create a standalone SQLite backup")
            # Session cookies and rate-limit history never enter the migration bundle.
            present = {row[0] for row in target.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            with target:
                for name in EXCLUDED & present:
                    target.execute(f"DELETE FROM {identifier(name)}")
        # Some SQLite builds leave an obsolete shared-memory index after changing
        # the backup's journal mode. Only this newly created private copy is touched.
        for suffix in ("-wal", "-shm"):
            Path(str(snapshot) + suffix).unlink(missing_ok=True)
        snapshot.chmod(0o600)
        with closing(readonly(snapshot)) as connection:
            if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("Snapshot integrity check failed")
            if connection.execute("PRAGMA foreign_key_check").fetchone():
                raise ValueError("Snapshot has broken record references")
            tables = snapshot_tables(connection)
        d1_preflight(tables)
        if any(row["status"] in ("queued", "running") for row in tables.get("jobs", {}).get("rows", [])):
            raise ValueError("Active analysis jobs exist; stop workers and finish or cancel jobs before export")
        files = []
        video_root = objects_root / "videos"
        if video_root.exists():
            if video_root.is_symlink():
                raise ValueError("Symlink video storage is not allowed")
            for path in sorted(video_root.rglob("*")):
                if path.is_symlink():
                    raise ValueError("Symlink objects are not allowed")
                if path.is_file():
                    files.append(file_record(objects_root, path.relative_to(objects_root).as_posix()))
        objects = {item["key"]: item for item in files}
        for video in tables.get("videos", {}).get("rows", []):
            object_path(objects_root, video["storage_key"])
            item = objects.get(video["storage_key"])
            if not item:
                raise ValueError(f"Missing source object for video {video['id']}")
            if item["size_bytes"] != video["size_bytes"] or item["sha256"] != video["sha256"]:
                raise ValueError(f"Source size/checksum mismatch for video {video['id']}")
        for job in tables.get("jobs", {}).get("rows", []):
            if job["status"] not in ("completed", "needs_review") or job["backend"] == "review_draft":
                continue
            names = ["normalized.mp4"]
            names += {"sample": ["pose.json"], "rtmpose": ["pose.json"], "rtmpose_tracking": ["pose.json"],
                      "pose3d": ["pose3d.json"], "sam2": ["segmentation.json"]}.get(job["backend"], [])
            for name in names:
                key = f"videos/{job['video_id']}/jobs/{job['id']}/{name}"
                if key not in objects:
                    raise ValueError(f"Missing completed analysis artifact: {key}")
        if source_signature(source_db) != before:
            raise ValueError("Source database changed during export; stop local writes and retry")
        manifest = {"schema_version": 1, "id": str(uuid4()), "created_at": datetime.now(timezone.utc).isoformat(),
                    "source_database": str(source_db), "objects_root": str(objects_root),
                    "snapshot": {"name": snapshot.name, "sha256": sha_file(snapshot)},
                    "excluded_tables": sorted(EXCLUDED), "table_order": list(tables),
                    "tables": {name: summarize(table) for name, table in tables.items()}, "objects": files}
        descriptor = os.open(destination / "manifest.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as out:
            out.write(canonical(manifest))
        bundle = validate_bundle(destination)
        if source_signature(source_db) != before:
            raise ValueError("Source database changed during export; stop local writes and retry")
        return bundle
    except Exception:
        shutil.rmtree(destination)
        raise


def validate_bundle(bundle, *, check_objects=True):
    folder = Path(bundle).resolve()
    manifest_path = folder / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("schema_version") != 1 or manifest.get("snapshot", {}).get("name") != "snapshot.sqlite3":
        raise ValueError("Unsupported migration bundle")
    snapshot = folder / "snapshot.sqlite3"
    if sha_file(snapshot) != manifest["snapshot"]["sha256"]:
        raise ValueError("Snapshot checksum mismatch")
    with closing(readonly(snapshot)) as connection:
        tables = snapshot_tables(connection)
    if list(tables) != manifest["table_order"] or {name: summarize(table) for name, table in tables.items()} != manifest["tables"]:
        raise ValueError("Snapshot row counts or hashes differ from the manifest")
    objects, seen = manifest["objects"], set()
    for item in objects:
        path = object_path(manifest["objects_root"], item["key"])
        if str(path) != item["source"] or item["key"] in seen:
            raise ValueError("Object manifest contains an unsafe or duplicate source")
        seen.add(item["key"])
        if check_objects and file_record(manifest["objects_root"], item["key"]) != item:
            raise ValueError(f"Object checksum mismatch: {item['key']}")
    return {"folder": folder, "manifest": manifest, "manifest_sha256": sha_file(manifest_path), "tables": tables}


def bundle_data(bundle, *, check_objects=False):
    return validate_bundle(bundle["folder"] if isinstance(bundle, dict) else bundle, check_objects=check_objects)


def verify_rows(query, bundle):
    bundle = bundle_data(bundle)
    for name, table in bundle["tables"].items():
        actual = cloud_rows(query, name, table)
        if canonical(actual) != canonical(table["rows"]):
            raise ValueError(f"Cloud records differ from snapshot: {name}")
    return {name: len(table["rows"]) for name, table in bundle["tables"].items()}


def cloud_rows(query, name, table):
    """Bound reads keep a table of large result JSON below REST response limits."""
    primary = table["primary_key"]
    columns = ",".join(map(identifier, primary))
    keys = query(f"SELECT {columns} FROM {identifier(name)} ORDER BY {columns}", [])
    predicate = " AND ".join(f"{identifier(key)}=?" for key in primary)
    rows = []
    for key in keys:
        record = query(f"SELECT * FROM {identifier(name)} WHERE {predicate}", [key[column] for column in primary])
        if len(record) != 1:
            raise ValueError("Cloud records changed during reconciliation")
        rows.extend(record)
    return rows


def mark_complete(query, bundle, counts):
    query("UPDATE cloud_migrations SET imported_at=?,table_counts=? WHERE id=? AND manifest_sha256=?",
          [datetime.now(timezone.utc).isoformat(), canonical(counts).decode(), bundle["manifest"]["id"], bundle["manifest_sha256"]])


def apply_records(query, bundle, *, finalize=True):
    """Insert original rows with bound values. Resume only an identical manifest.

    query(sql, params) returns dictionaries. It can be a real SQLite connection
    adapter for local validation or D1Query for explicit cloud import.
    """
    bundle = bundle_data(bundle)
    d1_preflight(bundle["tables"])
    manifest, manifest_hash = bundle["manifest"], bundle["manifest_sha256"]
    markers = query("SELECT * FROM cloud_migrations", [])
    marker = next((row for row in markers if row["id"] == manifest["id"]), None)
    if markers and (len(markers) != 1 or not marker or marker["manifest_sha256"] != manifest_hash):
        raise ValueError("Cloud database belongs to a different migration manifest")
    if not marker:
        for name in table_names(lambda sql: query(sql, [])):
            if name in EXCLUDED:
                continue
            if query(f"SELECT 1 AS present FROM {identifier(name)} LIMIT 1", []):
                raise ValueError(f"Cloud database is not empty: {name}")
        query("INSERT INTO cloud_migrations(id,manifest_sha256,imported_at,table_counts) VALUES(?,?,?,?)",
              [manifest["id"], manifest_hash, "pending", "{}"])
    existing_keys = {}
    for name, table in bundle["tables"].items():
        primary = table["primary_key"]
        expected = {canonical([row[key] for key in primary]): row for row in table["rows"]}
        existing = cloud_rows(query, name, table)
        seen = set()
        for row in existing:
            key = canonical([row[column] for column in primary])
            if key not in expected or canonical(row) != canonical(expected[key]):
                raise ValueError(f"Conflicting cloud record in {name}; no record was overwritten")
            seen.add(key)
        existing_keys[name] = seen
    for name, table in bundle["tables"].items():
        primary, seen = table["primary_key"], existing_keys[name]
        columns = table["columns"]
        sql = f"INSERT INTO {identifier(name)} ({','.join(map(identifier, columns))}) VALUES({','.join('?' for _ in columns)})"
        for row in table["rows"]:
            if canonical([row[key] for key in primary]) not in seen:
                query(sql, [row[column] for column in columns])
    counts = verify_rows(query, bundle)
    if finalize:
        mark_complete(query, bundle, counts)
    return counts


def head_object(client, bucket, key):
    from botocore.exceptions import ClientError
    try:
        return client.head_object(Bucket=bucket, Key=key)
    except ClientError as exc:
        if str(exc.response.get("Error", {}).get("Code")) in ("404", "NoSuchKey", "NotFound"):
            return None
        raise


def check_head(head, item):
    if not head or head.get("ContentLength") != item["size_bytes"] or head.get("Metadata", {}).get("sha256") != item["sha256"]:
        raise ValueError(f"Cloud object missing or checksum metadata conflicts: {item['key']}")


def sync_objects(client, bucket, bundle):
    bundle = bundle_data(bundle, check_objects=True)
    for item in bundle["manifest"]["objects"]:
        head = head_object(client, bucket, item["key"])
        if head:
            check_head(head, item)
            continue
        # File can change after bundle validation; check immediately before upload.
        if file_record(bundle["manifest"]["objects_root"], item["key"]) != item:
            raise ValueError("Source object changed before upload")
        client.upload_file(item["source"], bucket, item["key"], ExtraArgs={
            "Metadata": {"sha256": item["sha256"]},
            "ContentType": mimetypes.guess_type(item["key"])[0] or "application/octet-stream"})
        check_head(head_object(client, bucket, item["key"]), item)
        if file_record(bundle["manifest"]["objects_root"], item["key"]) != item:
            raise ValueError("Source object changed during upload; remote verification required")
    return len(bundle["manifest"]["objects"])


def verify_objects(client, bucket, bundle, *, full=False):
    bundle = bundle_data(bundle)
    for item in bundle["manifest"]["objects"]:
        check_head(head_object(client, bucket, item["key"]), item)
        if full:
            response = client.get_object(Bucket=bucket, Key=item["key"])
            count, checksum = 0, hashlib.sha256()
            body = response["Body"]
            try:
                while chunk := body.read(4 * 1024 * 1024):
                    count += len(chunk)
                    checksum.update(chunk)
            finally:
                body.close()
            if count != item["size_bytes"] or checksum.hexdigest() != item["sha256"]:
                raise ValueError(f"Cloud object content checksum mismatch: {item['key']}")
    return len(bundle["manifest"]["objects"])


class D1Query:
    def __init__(self, account_id, database_id, token):
        import httpx
        self.client = httpx.Client(timeout=120, follow_redirects=False, headers={"Authorization": f"Bearer {token}"})
        self.url = f"https://api.cloudflare.com/client/v4/accounts/{quote(account_id, safe='')}/d1/database/{quote(database_id, safe='')}/query"

    def __call__(self, sql, params=()):
        for attempt in range(8):
            response = self.client.post(self.url, json={"sql": sql, "params": list(params)})
            if response.status_code != 429 or attempt == 7:
                break
            try:
                pause = int(response.headers.get("retry-after", ""))
            except ValueError:
                pause = min(60, 5 * 2 ** attempt)
            time.sleep(min(60, max(1, pause)))
        response.raise_for_status()
        payload = response.json()
        if not payload.get("success") or not payload.get("result") or not payload["result"][0].get("success", True):
            raise RuntimeError("D1 query failed; migration remains resumable with the same manifest")
        return payload["result"][0].get("results", [])

    def close(self):
        self.client.close()


def credentials():
    names = ("CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_DATABASE_ID", "CLOUDFLARE_API_TOKEN", "S3_BUCKET")
    if any(not os.getenv(name) for name in names):
        raise ValueError("Remote commands require " + ", ".join(names) + " and private R2 credentials")
    import boto3
    query = D1Query(*(os.environ[name] for name in names[:3]))
    client = boto3.client("s3", endpoint_url=os.getenv("S3_ENDPOINT_URL") or
                          f"https://{os.environ['CLOUDFLARE_ACCOUNT_ID']}.r2.cloudflarestorage.com",
                          region_name="auto")
    return query, client, os.environ["S3_BUCKET"]


def import_bundle(query, client, bucket, bundle):
    """Mark import complete only after the actual remote bytes reconcile."""
    apply_records(query, bundle, finalize=False)
    objects = sync_objects(client, bucket, bundle)
    counts = verify_rows(query, bundle)
    verify_objects(client, bucket, bundle, full=True)
    mark_complete(query, bundle, counts)
    return counts, objects


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    export = commands.add_parser("export", help="Local read-only snapshot and manifest; no cloud requests")
    export.add_argument("--database", type=Path, default=ROOT / "data" / "arena.db")
    export.add_argument("--objects", type=Path, default=ROOT / "data" / "objects")
    export.add_argument("--output", type=Path)
    upload = commands.add_parser("import", help="Explicitly copy private objects and records to an empty cloud database")
    upload.add_argument("bundle", type=Path)
    verify = commands.add_parser("verify", help="Compare all imported records and private object metadata")
    verify.add_argument("bundle", type=Path)
    verify.add_argument("--full", action="store_true", help="Stream and checksum every cloud object's bytes")
    args = parser.parse_args()
    os.umask(0o077)
    if args.command == "export":
        output = args.output or ROOT / "data" / "cloudflare-migration" / (datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid4().hex[:8])
        bundle = export_bundle(args.database, args.objects, output)
        print(json.dumps({"bundle": str(bundle["folder"]), "manifest_sha256": bundle["manifest_sha256"],
                          "counts": {name: table["count"] for name, table in bundle["manifest"]["tables"].items()},
                          "objects": len(bundle["manifest"]["objects"])}, ensure_ascii=False))
        return
    bundle = validate_bundle(args.bundle, check_objects=args.command == "import")
    query, client, bucket = credentials()
    try:
        if args.command == "import":
            # Refuse database conflicts before any R2 write. Record import is kept
            # private until uploads and full reconciliation finish; don't start API
            # traffic until this command succeeds.
            counts, objects = import_bundle(query, client, bucket, bundle)
        else:
            counts = verify_rows(query, bundle)
            objects = verify_objects(client, bucket, bundle, full=args.full)
        print(json.dumps({"verified_counts": counts, "objects": objects}, ensure_ascii=False))
    finally:
        query.close()


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError) as exc:
        sys.exit(str(exc))
