# Cloudflare + local inference

GOAL: preserve NeuroStability features and real records while hosting the website on Cloudflare; run inference on the existing computer and automatically synchronize artifacts and results.
CONTEXT: React/Vite UI uses same-origin /api; existing FastAPI/SQLAlchemy/local worker remains a supported offline installation.
CONSTRAINTS: no deletion or mutation of the live local database; no real data, video, passwords or model weights in Git; no paid cloud resources created without an account; target Workers Free + D1 + private R2. Free quotas are not unlimited. Keep source provenance, score/review/assessment history and experimental measurement labels. Never infer identity from gender or fabricate results.
DONE WHEN: all existing browser API operations are supported, migration verifies record and artifact checksums, authenticated local-worker lease/download/progress/upload/complete works through real local Cloudflare emulation, interrupted/stale workers cannot publish, existing Python/frontend tests and new integration tests pass. Production deploy remains dependent on Cloudflare credentials/resources/payment eligibility and network testing.

## Architecture and decisions

The user chose Cloudflare with computer inference over ECS. Static UI is served by Workers Assets; a small TypeScript API uses D1 (same SQLite schema) and private R2. The Python inference code remains local and is reused, not ported or replaced. Do not expose local ports or the database to the Internet. A dedicated revocable worker bearer secret authorizes task operations only, separate from browser cookies/CSRF. A migration command creates an SQLite backup, schema/export and R2 object manifest and imports only into an empty cloud database. Preserve original IDs, hashes, timestamps and raw stored JSON. Exclude temporary browser sessions and login attempts.

Alternative: Cloudflare Containers could reuse FastAPI directly but requires a paid plan and persistent database arrangement. Retaining ECS would simplify backend deployment but adds permanent compute rent. Workers/D1 requires API adaptation; this is the chosen implementation tradeoff, not an assertion that the old Docker image runs on Free.

## Components

- `cloudflare/`: Worker API, D1 migration, Wrangler config and local integration tests. API response shapes must match `arena/api.py`, including reports, analytics, plans, profiles, review and score history, media Range support and private artifacts.
- `arena/remote_worker.py`: outgoing HTTPS-only task client (loopback HTTP allowed for tests), local isolated SQLite task context and existing `run_once`; uploads immutable artifacts then commits result; persistent outbox resumes transient sync failures; heartbeat prevents premature expiry.
- `scripts/cloudflare_migrate.py`: read-only SQLite snapshot/export, checksums/count reconciliation, resumable R2 transfer. Never silently replace cloud data.
- Upload: browser multipart chunks below request limits, maximum 512MiB source, finalize after exact R2 size check. Cloudflare worker must not buffer or hash the full video. Computer verifies existing source hash before processing; for a new upload without a hash, it computes one while downloading and records it atomically on fenced completion. Existing imported hashes are never overwritten. Existing local 100MiB route remains compatible.
- LLM draft requests are queued to the local worker too; no model/API secret in the browser. Cloud UI polls until draft exists.

## Task protocol (v1)

`Authorization: Bearer ARENA_WORKER_TOKEN`; all routes under `/api/worker`.

- `POST /heartbeat`: `{worker_id, models}` stores capabilities + last_seen.
- `POST /claim`: `{worker_id, backends:[...]}` -> `{job,video,source_job,review?}` or 204. Leases last 180 seconds, renew every 30 seconds. `job.worker_token` is a fresh fencing token; only one active job per video. Expired jobs can be reclaimed with a new token; old tokens cannot upload/commit.
- `POST /jobs/:id/heartbeat`: `{worker_token,stage?,progress?}` renews lease.
- `GET /jobs/:id/source?artifact=source|normalized.mp4|pose.json`: `X-Worker-Lease` token, validated ownership; source artifacts only from that video's validated source job.
- `PUT /jobs/:id/artifacts/:name`: `X-Worker-Lease`; allowed names normalized.mp4,pose.json,pose3d.json,segmentation.json; chunk uploads (<=8MiB) use `?upload_id=&part=` and multipart init/finalize actions if needed. API may return presigned upload instructions as protocol refinement documented alongside client/tests.
- `POST /jobs/:id/complete`: `{worker_token,status,stage,metadata,result,error,draft?}` idempotent with same lease+payload; disallow arbitrary keys/paths, require result artifacts for completed real analyses; atomically fences publication and stores optional language draft. Rejected stale results stay private and cannot overwrite live state.

## Implementation plan

1. Add schema/config and real local D1/R2 integration harness; snapshot real local records before changes.
2. Port API and statistics/export logic preserving response and validation behavior. Test auth, history, capabilities, duplicate jobs, leases, private media and ranges.
3. Build outgoing local worker using existing inference, reconnect/outbox and source checksums. Test interruption, duplicate completion, stale token and real preprocessing.
4. Add direct chunk upload and queued review handling to existing frontend; keep English/Chinese and existing UI.
5. Verify migration by record counts/row hashes/object hashes; test complete flow with generated test video (not user records), run existing suites, document deploy/pair/start/recovery commands.

## Review focus

Deleted video/stale lease cannot republish; retries must not duplicate scores/drafts; old credentials and histories must survive migration; large video/artifact upload must never hit 100MB request limit; computer offline must not make stored results unavailable; all migrated data and artifacts remain private.

## Progress

Design follows the already authorized architecture; no additional approval checkpoint introduced. Cloud resource creation and production data upload await actual Cloudflare account configuration, not completion claims from local tests.

- Implemented Worker/D1/R2 API, existing React client adaptation, outgoing Python inference, private resumable migration, isolated Cloudflare account launcher and computer pairing launcher.
- Tested with official local D1/R2 runtime and real HTTP Python/FFmpeg processing; dense three-person results over 1MiB are preserved in R2 and restored exactly. Collection pages use compact summaries to avoid 70 R2 reads per listing.
- Added cancellation fencing, idempotent browser upload finalization, source SHA establishment, immutable score/review/assessment history, CSV/ZIP parity tests against Python, and full remote-byte verification before migration completion markers.
- Real-data export: all original tables were imported into local D1 emulation and row-hash verified. Source tables remain unchanged. Counts, hashes, file sizes and private paths live only in ignored `data/cloudflare-migration/`; no real data uploaded.
- Production is pending the user's new Cloudflare account login and R2 activation. Existing global account was inspected read-only and is explicitly not the deployment target. The project now uses an isolated login directory.
- User clarified deployment must be via GitHub and requested no further browser operation. Primary release path is now Workers Builds connected to `main`, root `cloudflare`, `build:site` + `deploy:ci`. Cloudflare build variables supply account/D1 IDs, CI uses Cloudflare's own build credentials; runtime worker secret stays outside Git. No further browser actions or OAuth login attempts are authorized or needed. Prior temporary login link expired without authorization.
- Local emulation does not enforce production Free CPU billing; a target-account smoke test and quota monitoring remain required. Existing oversized legacy rows are rejected before cloud mutation (1.9MB safety threshold); the existing dataset passes this check. New dense outputs spill to R2.

Final protocol refinements: browser uploads use POST `/api/uploads`, PUT `/:id/parts/:n`, POST `/:id/complete`, DELETE `/:id`. Artifact uploads use POST `/api/worker/jobs/:id/artifacts/:name/init`, PUT `?upload_id=&part=`, POST `/finalize`. `result.json` is an additional fenced private artifact for large results; completion sends `result_artifact:true` and only removes kinematics `series` from the D1 summary. Original JSON is restored for individual result/report requests. Cancellation is authenticated POST `/api/jobs/:id/cancel` and revokes the old worker token.
