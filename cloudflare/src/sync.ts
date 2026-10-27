import { APIError, body, json, object, sha256, workerAuth } from './auth';
import { compactResult, MAX_RESULT_BYTES } from './media';

export const SYNC_COLUMNS: Record<string, string[]> = {
  "schema_version": [
    "version"
  ],
  "users": [
    "id",
    "username",
    "password_hash"
  ],
  "athletes": [
    "id",
    "name",
    "level",
    "created_at"
  ],
  "sessions": [
    "id",
    "athlete_id",
    "date",
    "objective",
    "duration_min",
    "rpe",
    "notes",
    "created_at"
  ],
  "training_plans": [
    "id",
    "athlete_id",
    "date",
    "category",
    "objective",
    "planned_minutes",
    "status",
    "session_id",
    "created_at"
  ],
  "videos": [
    "id",
    "session_id",
    "category",
    "filename",
    "storage_key",
    "sha256",
    "size_bytes",
    "status",
    "authorized_at",
    "created_at"
  ],
  "jobs": [
    "id",
    "video_id",
    "backend",
    "status",
    "stage",
    "progress",
    "params",
    "metadata",
    "result",
    "error",
    "lease_until",
    "worker_token",
    "created_at",
    "updated_at"
  ],
  "review_drafts": [
    "id",
    "video_id",
    "job_id",
    "provider",
    "model",
    "synthetic",
    "text",
    "facts",
    "created_at"
  ],
  "reviews": [
    "id",
    "video_id",
    "draft_id",
    "observations",
    "next_action",
    "confirmed",
    "confirmed_by",
    "updated_at"
  ],
  "review_history": [
    "id",
    "video_id",
    "snapshot",
    "created_at"
  ],
  "manual_scores": [
    "id",
    "video_id",
    "score",
    "comment",
    "confirmed",
    "assessor",
    "rubric_version",
    "updated_at"
  ],
  "score_history": [
    "id",
    "video_id",
    "snapshot",
    "created_at"
  ],
  "analysis_assessments": [
    "id",
    "job_id",
    "decision",
    "subject_role",
    "reason",
    "reviewer",
    "updated_at"
  ],
  "analysis_assessment_history": [
    "id",
    "job_id",
    "snapshot",
    "created_at"
  ],
  "events": [
    "id",
    "video_id",
    "source_job_id",
    "start_sec",
    "end_sec",
    "label",
    "actor",
    "outcome",
    "notes",
    "created_by",
    "created_at"
  ]
};

/** Worker-only, exact-row synchronization. Original JSON columns stay strings. */
export async function syncRoute(req: Request, env: any): Promise<Response | null> {
    const url = new URL(req.url);
    const manifest = /^\/api\/worker\/sync\/manifest\/([^/]+)$/.exec(url.pathname);
    const record = /^\/api\/worker\/sync\/records\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (!manifest && !record) return null;
    workerAuth(req, env);
    const table = (manifest || record)![1];
    const columns = Object.hasOwn(SYNC_COLUMNS, table) ? SYNC_COLUMNS[table] : null;
    if (!columns) throw new APIError(404, 'Unknown synchronization table');
    if (manifest && req.method === 'GET') {
        const limit = Number(url.searchParams.get('limit') || 500);
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new APIError(422, 'Invalid page limit');
        const result = await env.DB.prepare('SELECT record_key AS key,revision,deleted FROM sync_versions WHERE table_name=? AND record_key>? ORDER BY record_key LIMIT ?')
            .bind(table, url.searchParams.get('cursor') || '', limit).all();
        const records = result.results.map((v: any) => ({ ...v, deleted: !!v.deleted }));
        return json({ records, cursor: records.length === limit ? records[records.length - 1].key : null });
    }
    if (!record) throw new APIError(405, 'Method not allowed');
    let key: string;
    try { key = decodeURIComponent(record[2]); } catch { throw new APIError(422, 'Invalid key'); }
    if (!key || key.length > 200) throw new APIError(422, 'Invalid key');
    const primary = columns[0];
    const versionSQL = 'SELECT revision,deleted FROM sync_versions WHERE table_name=? AND record_key=?';
    if (req.method === 'GET') {
        const results = await env.DB.batch([
            env.DB.prepare(versionSQL).bind(table, key),
            env.DB.prepare(`SELECT * FROM ${table} WHERE ${primary}=?`).bind(key),
        ]);
        const version = results[0].results[0];
        if (!version) throw new APIError(404, 'Record not found');
        const row = results[1].results[0] || null;
        if (table === 'jobs' && typeof row?.result === 'string') {
            let parsed: any;
            try { parsed = JSON.parse(row.result); } catch { /* Preserve original non-pointer JSON strings. */ }
            if (parsed && typeof parsed === 'object' && Object.hasOwn(parsed, '_full_result_key')) {
                const artifactKey = parsed._full_result_key;
                if (typeof artifactKey !== 'string' || !artifactKey.startsWith(`videos/${row.video_id}/jobs/${row.id}/`) || !artifactKey.endsWith('/result.json'))
                    throw new APIError(502, 'Invalid full result reference');
                const artifact = await env.MEDIA.get(artifactKey);
                if (!artifact || artifact.size > MAX_RESULT_BYTES) throw new APIError(502, 'Full result unavailable');
                const data = await artifact.arrayBuffer();
                if (artifact.customMetadata?.sha256 && await sha256(data) !== artifact.customMetadata.sha256) throw new APIError(502, 'Full result integrity failure');
                // Keep the raw UTF-8 string, including whitespace, for stable local fingerprints.
                row.result = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(data);
            }
        }
        return json({ row, revision: version.revision, deleted: !!version.deleted });
    }
    if (req.method !== 'PUT') throw new APIError(405, 'Method not allowed');
    const payload = await body(req, ['row', 'expected_revision'], 16 * 1024 * 1024);
    const row = object(payload.row, columns);
    if (columns.some(c => !Object.hasOwn(row, c)) || String(row[primary]) !== key ||
        columns.some(c => row[c] !== null && !['string', 'number', 'boolean'].includes(typeof row[c])))
        throw new APIError(422, 'An exact original row is required');
    const revision = payload.expected_revision;
    if (revision !== null && (typeof revision !== 'string' || !/^[a-f0-9]{32}$/.test(revision)))
        throw new APIError(422, 'Invalid expected revision');
    // The condition and mutation are one statement. Tombstones cannot be recreated.
    const condition = revision === null
        ? 'NOT EXISTS(SELECT 1 FROM sync_versions WHERE table_name=? AND record_key=?)'
        : 'EXISTS(SELECT 1 FROM sync_versions WHERE table_name=? AND record_key=? AND revision=? AND deleted=0)';
    let storedRow = row, artifactKey: string | null = null;
    if (table === 'jobs' && typeof row.result === 'string' && new TextEncoder().encode(row.result).length > 1536 * 1024) {
        let parsed: any;
        try { parsed = JSON.parse(row.result); } catch { throw new APIError(422, 'Invalid result JSON'); }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.hasOwn(parsed, '_full_result_key')) throw new APIError(422, 'Invalid result JSON');
        artifactKey = `videos/${row.video_id}/jobs/${row.id}/sync/${crypto.randomUUID()}/result.json`;
        await env.MEDIA.put(artifactKey, row.result, { httpMetadata: { contentType: 'application/json' }, customMetadata: { sha256: await sha256(row.result) } });
        storedRow = { ...row, result: JSON.stringify({ ...compactResult(parsed), _full_result_key: artifactKey }) };
        if (new TextEncoder().encode(storedRow.result).length > 1536 * 1024) {
            await env.MEDIA.delete(artifactKey);
            throw new APIError(413, 'Result summary exceeds D1 row limit; original retained locally');
        }
    }
    const params = revision === null ? [table, key] : [table, key, revision];
    if (new TextEncoder().encode(JSON.stringify(storedRow)).byteLength > 1900000) throw new APIError(413, 'D1 row limit exceeded; original record preserved');
    const assignments = columns.filter(c => c !== primary).map(c => `${c}=excluded.${c}`).join(',');
    const conflict = assignments ? `DO UPDATE SET ${assignments} WHERE ${condition}` : 'DO NOTHING';
    const statement = `INSERT INTO ${table}(${columns.join(',')}) SELECT ${columns.map(() => '?').join(',')} WHERE ${condition} ON CONFLICT(${primary}) ${conflict}`;
    let results;
    try { results = await env.DB.batch([
        env.DB.prepare(statement).bind(...columns.map(c => storedRow[c] === true ? 1 : storedRow[c] === false ? 0 : storedRow[c]), ...params, ...(assignments ? params : [])),
        env.DB.prepare(versionSQL).bind(table, key),
    ]); } catch (error: any) {
        if (artifactKey) await env.MEDIA.delete(artifactKey);
        if (/constraint|SQLITE_CONSTRAINT/i.test(error?.message || '')) throw new APIError(409, 'Referenced or unique record differs; both copies preserved');
        throw error;
    }
    if (!results[0].meta.changes) {
        if (artifactKey) await env.MEDIA.delete(artifactKey);
        throw new APIError(409, 'Synchronization conflict; neither copy was overwritten');
    }
    return json({ row, revision: results[1].results[0].revision, deleted: false });
}
