# Cloudflare results-only migration — accepted 2026-10-28

GOAL: local AI analysis automatically synchronizes exact records and JSON results to a Cloudflare Workers/D1 website without R2.
CONTEXT: preserve the existing SQLite archive and frontend; GitHub remains code-only. User accepted this design and requested implementation, testing and push in the current session.
CONSTRAINTS: videos/models/rendered media stay on the computer. No browser operations, payment registration or live cloud mutation. No fabricated results. Minimal dependencies; existing inference code remains. Local original archive is retained on cloud deletion; concurrent divergent edits require explicit conflict resolution.
DONE WHEN: D1-only Git deployment validates, exact original records/artifacts reconcile in local cloud emulation, cloud-created jobs compute against verified local media, JSON results and dashboard survive computer shutdown, tests pass and code is pushed.

## Plan and interfaces

- [x] D1 JSON storage: bounded rows, exact bytes, SHA256, atomic publish, 16MiB/file; reject raw video uploads. Existing R2 adapter remains optional compatibility only, with no production binding.
- [x] Record synchronization: original 15 tables, raw JSON/password hashes preserved, CAS revisions and tombstones. Private checkpoints and no destructive automatic deletes. Cloud active jobs are not pulled into the local execution database.
- [x] Local bridge: seed original records, synchronize existing JSON artifacts, run local inference and regularly reconcile updates. Local-owned queued/running jobs are excluded from cloud claims to prevent duplicate analysis. Durable private per-site checkpoints; no management API token needed.
- [x] Frontend: cloud upload directs users to local workspace; 2D/tracks/masks play from saved data without a video; original media is explicitly local-only. Local website flow remains.
- [x] Integration: real-data read-only backup and hashes; real Miniflare D1 with no R2; generated test video for local inference; complete regression suites, dry-run build, source/secret audit and Git push.

## Architecture decisions

Workers Assets serves the same React UI; D1 contains relational records and chunked JSON files. Raw video never enters D1. Two threads in the local bridge independently synchronize records and claim cloud jobs. Browser authentication retains existing password hashes and the existing one-use proof protocol. Worker bearer is private and scoped to this application, stored outside Git. Original cloud APIs and analytical limitations remain; no missing model is marked ready.

Full video playback is available on the original local workspace. Cloud 2D/tracks/masks use saved image-plane coordinates, and 3D retains model-relative units. The website does not imply uploaded raw media exists in the cloud. Online limits still apply; emulator tests cannot certify production CPU quota.

## Validation record

Real-data verification uses a temporary SQLite backup plus read-only local objects, never production cloud resources. Every original row and every JSON artifact must match on a second pass; all source records remain unchanged. Raw video upload endpoints reject requests before parsing bytes.

Review fixes: immutable artifact pointers publish using atomic INSERT; reads resolve worker lease keys; missing local JSON is restored with SHA256; interrupted multipart finalization uses expiring fencing tokens. Per-site checkpoints reject endpoint reuse, and local active jobs never enter the cloud execution queue.

Verified commands on 2026-10-28:

- Python unittest discovery: 261 run, 11 explicit opt-in/dependency skips, no failures.
- Frontend: 93 tests passed; TypeScript/Vite production build passed.
- Cloudflare: 38 tests passed, including no-R2 HTTP/local-video processing, D1 multipart fencing and artifact conflict tests.
- Temporary real-data clone: all 15 original table row fingerprints matched; every available original JSON artifact matched full remote bytes; second cycle had no writes/conflicts. Original records remained unchanged. This verification used only a loopback emulator, not a cloud account.
- Git deployment configuration contains only D1 + Assets and results-only variables; no R2 binding or credentials. Wrangler dry-run checked separately before commit.

The complete raw-media archive remains local. Production deployment and CPU/quota/network verification require the user's Cloudflare account and actual site URL. No paid resources or production data were created by these checks.
