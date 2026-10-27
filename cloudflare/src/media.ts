import { APIError, body, boolean, choice, epoch, json, now, number, sha256, text } from './auth';
export const PART_SIZE = 8 * 1024 * 1024;
export const resultsOnly = (env: any) => env.ARENA_RESULTS_ONLY === 'true' || env.MEDIA?.resultsOnly === true;
export function localMediaOnly(): never { throw new APIError(409, 'local_media_only: 视频与模型保留在本地，请在本地导入和分析；云端仅保存 JSON 结果'); }
const categories = ['stability', 'footwork', 'attack', 'defense', 'mixed'];
export const MAX_RESULT_BYTES = 16 * 1024 * 1024;
export function compactResult(result: any) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
    if (!Array.isArray(result.kinematics?.tracks)) return { ...result };
    return { ...result, kinematics: { ...result.kinematics, tracks: result.kinematics.tracks.map((track: any) => {
        if (!track || typeof track !== 'object' || Array.isArray(track)) return track;
        const { series, ...summary } = track;
        return summary;
    }) } };
}
export function resultSummary(row: any) {
    if (!row?.result || typeof row.result !== 'object') return row;
    const { _full_result_key, ...result } = compactResult(row.result);
    return { ...row, result };
}
export async function resultHydrate(env: any, row: any) {
    if (!row?.result || typeof row.result !== 'object' || !Object.hasOwn(row.result, '_full_result_key')) return row;
    const { _full_result_key: key, ...summary } = row.result;
    // Aggregate queries intentionally use the compact summary. Never expose storage pointers.
    if (!row.id || !row.video_id) return { ...row, result: summary };
    if (typeof key !== 'string' || !key.startsWith(`videos/${row.video_id}/jobs/${row.id}/`) || !key.endsWith('/result.json')) throw new APIError(502, '分析结果引用无效');
    const artifact = await env.MEDIA.get(key);
    if (!artifact || artifact.size > MAX_RESULT_BYTES) throw new APIError(502, '完整分析结果不存在或超出读取限制');
    const data = await artifact.arrayBuffer();
    if (artifact.customMetadata?.sha256 && await sha256(data) !== artifact.customMetadata.sha256) throw new APIError(502, '完整分析结果校验失败');
    let result;
    try { result = JSON.parse(new TextDecoder().decode(data)); } catch { throw new APIError(502, '完整分析结果 JSON 无效'); }
    if (!result || typeof result !== 'object' || Array.isArray(result) || Object.hasOwn(result, '_full_result_key')) throw new APIError(502, '完整分析结果格式无效');
    return { ...row, result };
}
export async function requireRow(env: any, table: string, id: string) {
    const row = await env.DB.prepare(`SELECT * FROM ${table} WHERE id=?`).bind(id).first();
    if (!row) throw new APIError(404, '记录不存在');
    return resultHydrate(env, decodeRow(row));
}
export function decodeRow(row: any) { if (!row)
    return row; const out = { ...row }; for (const k of ['params', 'metadata', 'result', 'snapshot', 'facts', 'models'])
    if (typeof out[k] === 'string') {
        try {
            out[k] = JSON.parse(out[k]);
        }
        catch {
            out[k] = null;
        }
    } for (const k of ['confirmed', 'synthetic'])
    if (out[k] !== undefined)
        out[k] = !!out[k]; return out; }
export async function rows(env: any, sql: string, args: any[] = []): Promise<any[]> { return Promise.all((await env.DB.prepare(sql).bind(...args).all()).results.map((row: any) => resultHydrate(env, decodeRow(row)))); }
export function insert(env: any, table: string, data: any) { const keys = Object.keys(data); return env.DB.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`).bind(...keys.map(k => encode(data[k]))); }
export function encode(v: any) { return v === undefined ? null : typeof v === 'boolean' ? Number(v) : v !== null && typeof v === 'object' ? JSON.stringify(v) : v; }
export async function removePrefix(env: any, prefix: string) { let cursor; do {
    const page: any = await env.MEDIA.list({ prefix, cursor });
    if (page.objects.length)
        await env.MEDIA.delete(page.objects.map((v: any) => v.key));
    cursor = page.truncated ? page.cursor : undefined;
} while (cursor); }
export async function storedFile(req: Request, env: any, key: string, type: string, filename?: string) {
    const head = await env.MEDIA.head(key);
    if (!head)
        throw new APIError(404, '文件不存在');
    const headers = new Headers({ 'content-type': type, 'accept-ranges': 'bytes', 'etag': head.httpEtag, 'content-length': String(head.size) });
    if (filename)
        headers.set('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(filename)}`);
    let range: any, status = 200;
    const raw = req.headers.get('range');
    if (raw) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(raw);
        if (!m || (!m[1] && !m[2]))
            return new Response(null, { status: 416, headers: { 'content-range': `bytes */${head.size}` } });
        let start = m[1] ? Number(m[1]) : Math.max(0, head.size - Number(m[2])), end = m[2] && m[1] ? Number(m[2]) : head.size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= head.size || end < start)
            return new Response(null, { status: 416, headers: { 'content-range': `bytes */${head.size}` } });
        end = Math.min(end, head.size - 1);
        range = { offset: start, length: end - start + 1 };
        status = 206;
        headers.set('content-range', `bytes ${start}-${end}/${head.size}`);
        headers.set('content-length', String(end - start + 1));
    }
    if (req.method === 'HEAD')
        return new Response(null, { status, headers });
    const object = await env.MEDIA.get(key, range ? { range } : undefined);
    if (!object)
        throw new APIError(404, '文件不存在');
    return new Response(object.body, { status, headers });
}
export async function jobArtifactKey(env: any, job: any, name: string) { const published = await env.DB.prepare('SELECT a.storage_key FROM job_artifacts a JOIN worker_completions c ON c.job_id=a.job_id AND c.worker_token=a.worker_token WHERE a.job_id=? AND a.name=?').bind(job.id, name).first(); const historical = published ? null : await env.DB.prepare("SELECT storage_key FROM job_artifacts WHERE job_id=? AND name=? AND worker_token='historical-sync'").bind(job.id, name).first(); return published?.storage_key || historical?.storage_key || `videos/${job.video_id}/jobs/${job.id}/${name}`; }
function uploadPayload(p: any) { const filename = text(p.filename, 200, 1).replace(/\\/g, '/').split('/').pop()!; if (!/\.(mp4|mov|webm|mkv|m4v)$/i.test(filename))
    throw new APIError(422, '支持 MP4、MOV、WebM、MKV、M4V 视频'); if (!boolean(p.authorized))
    throw new APIError(422, '请确认已获得视频中所有相关人员的上传和分析授权'); if (p.sha256 !== undefined && p.sha256 !== '' && (typeof p.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(p.sha256)))
    throw new APIError(422, 'SHA256 无效'); return { session_id: text(p.session_id, 36, 1), category: choice(p.category, categories), filename, size_bytes: number(p.size_bytes, 1, 512 * 1024 * 1024, true), sha256: p.sha256 || '' }; }
async function uploadRecord(env: any, id: string) { const u = await env.DB.prepare('SELECT * FROM uploads WHERE id=? AND expires>?').bind(id, epoch()).first(); if (!u)
    throw new APIError(404, '上传不存在或已过期'); return { ...u, payload: JSON.parse(u.payload) }; }
export async function mediaRoute(req: Request, env: any): Promise<Response | null> {
    const path = new URL(req.url).pathname;
    let m;
    if (path === '/api/upload-config' && req.method === 'GET')
        return resultsOnly(env) ? json({ mode: 'local', max_size_bytes: 512 * 1024 * 1024, max_result_bytes: MAX_RESULT_BYTES }) : json({ mode: 'multipart', max_size_bytes: 512 * 1024 * 1024, part_size: PART_SIZE });
    if (resultsOnly(env) && ((path === '/api/videos' && req.method === 'POST') || path === '/api/uploads' || path.startsWith('/api/uploads/') || /^\/api\/(videos|jobs)\/[^/]+\/media$/.test(path))) localMediaOnly();
    if (path === '/api/uploads' && req.method === 'POST') {
        const p = uploadPayload(await body(req, ['session_id', 'category', 'authorized', 'filename', 'size_bytes', 'sha256']));
        await requireRow(env, 'sessions', p.session_id);
        const id = crypto.randomUUID(), videoId = crypto.randomUUID(), key = `videos/${videoId}/source${p.filename.slice(p.filename.lastIndexOf('.')).toLowerCase()}`;
        const upload = await env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: 'application/octet-stream' } });
        try {
            await insert(env, 'uploads', { id, video_id: videoId, storage_key: key, multipart_id: upload.uploadId, payload: { ...p, parts: {} }, expires: epoch() + 86400 }).run();
        }
        catch (e) {
            await upload.abort();
            throw e;
        }
        return json({ id, upload_id: id, video_id: videoId, part_size: PART_SIZE, max_size_bytes: 512 * 1024 * 1024 }, 201);
    }
    if ((m = /^\/api\/uploads\/([^/]+)\/parts\/(\d+)$/.exec(path)) && req.method === 'PUT') {
        const u = await uploadRecord(env, m[1]), part = Number(m[2]);
        if (await env.DB.prepare('SELECT id FROM videos WHERE id=?').bind(u.video_id).first())
            throw new APIError(409, '上传已完成');
        const maxParts = Math.ceil(u.payload.size_bytes / PART_SIZE);
        if (part < 1 || part > maxParts)
            throw new APIError(422, '分片编号无效');
        const data = await readPart(req), expected = part === maxParts ? u.payload.size_bytes - PART_SIZE * (part - 1) : PART_SIZE;
        if (data.byteLength !== expected)
            throw new APIError(422, '分片大小不匹配');
        const result = await env.MEDIA.resumeMultipartUpload(u.storage_key, u.multipart_id).uploadPart(part, data);
        await env.DB.prepare("UPDATE uploads SET payload=json_set(payload,'$.parts',json_patch(json_extract(payload,'$.parts'),json(?))) WHERE id=?").bind(JSON.stringify({ [String(part)]: result }), u.id).run();
        return json(result);
    }
    if ((m = /^\/api\/uploads\/([^/]+)\/complete$/.exec(path)) && req.method === 'POST') {
        const u = await uploadRecord(env, m[1]), p = u.payload;
        const existing = await env.DB.prepare('SELECT * FROM videos WHERE id=?').bind(u.video_id).first();
        if (existing) {
            delete existing.storage_key;
            return json(existing, 201);
        }
        const parts = Object.values(p.parts).sort((a: any, b: any) => a.partNumber - b.partNumber) as any[], n = Math.ceil(p.size_bytes / PART_SIZE);
        if (parts.length !== n || parts.some((v: any, i: number) => v.partNumber !== i + 1))
            throw new APIError(409, '上传分片不完整');
        await requireRow(env, 'sessions', p.session_id);
        let obj = await env.MEDIA.head(u.storage_key);
        if (!obj)
            obj = await env.MEDIA.resumeMultipartUpload(u.storage_key, u.multipart_id).complete(parts);
        if (obj.size !== p.size_bytes) {
            await env.MEDIA.delete(u.storage_key);
            throw new APIError(422, '视频大小校验失败');
        }
        const stamp = now(), record = { id: u.video_id, session_id: p.session_id, category: p.category, filename: p.filename, storage_key: u.storage_key, sha256: p.sha256, size_bytes: p.size_bytes, status: 'uploaded', authorized_at: stamp, created_at: stamp };
        await insert(env, 'videos', record).run();
        const { storage_key, ...visible } = record;
        return json(visible, 201);
    }
    if ((m = /^\/api\/uploads\/([^/]+)$/.exec(path)) && req.method === 'DELETE') {
        const u = await uploadRecord(env, m[1]);
        if (await env.DB.prepare('SELECT id FROM videos WHERE id=?').bind(u.video_id).first())
            throw new APIError(409, '上传已完成');
        await env.MEDIA.resumeMultipartUpload(u.storage_key, u.multipart_id).abort();
        await env.MEDIA.delete(u.storage_key);
        await env.DB.prepare('DELETE FROM uploads WHERE id=?').bind(u.id).run();
        return new Response(null, { status: 204 });
    }
    // Compatibility for clients that still upload small files in a single form request.
    if (path === '/api/videos' && req.method === 'POST') {
        const length = Number(req.headers.get('content-length'));
        if (!length || length > PART_SIZE + 1024 * 1024)
            throw new APIError(413, '请使用分片上传');
        const form = await req.formData();
        const file: unknown = form.get('file');
        if (!(file instanceof File) || file.size > PART_SIZE)
            throw new APIError(413, '请使用分片上传');
        const data = await file.arrayBuffer(), p = uploadPayload({ session_id: form.get('session_id'), category: form.get('category'), authorized: form.get('authorized') === 'true', filename: file.name, size_bytes: file.size, sha256: await sha256(data) });
        await requireRow(env, 'sessions', p.session_id);
        const id = crypto.randomUUID(), key = `videos/${id}/source${p.filename.slice(p.filename.lastIndexOf('.')).toLowerCase()}`, stamp = now();
        await env.MEDIA.put(key, data, { httpMetadata: { contentType: file.type || 'application/octet-stream' } });
        const record = { id, ...p, storage_key: key, status: 'uploaded', authorized_at: stamp, created_at: stamp };
        try {
            await insert(env, 'videos', record).run();
        }
        catch (e) {
            await env.MEDIA.delete(key);
            throw e;
        }
        const { storage_key, ...out } = record;
        return json(out, 201);
    }
    if ((m = /^\/api\/videos\/([^/]+)\/media$/.exec(path)) && ['GET', 'HEAD'].includes(req.method)) {
        const v = await requireRow(env, 'videos', m[1]);
        return storedFile(req, env, v.storage_key, v.filename.toLowerCase().endsWith('.webm') ? 'video/webm' : 'video/mp4', v.filename);
    }
    if ((m = /^\/api\/jobs\/([^/]+)\/(media|pose|pose3d|segmentation)$/.exec(path)) && ['GET', 'HEAD'].includes(req.method)) {
        const j = await requireRow(env, 'jobs', m[1]), kind = m[2];
        if (kind === 'media' && !j.metadata)
            throw new APIError(409, '预处理尚未完成');
        if (kind === 'pose' && (!j.result || !['sample', 'rtmpose', 'rtmpose_tracking'].includes(j.backend)))
            throw new APIError(409, '此任务尚无二维关键点结果');
        if (['pose3d', 'segmentation'].includes(kind) && (!j.result || j.result.kind !== kind))
            throw new APIError(409, '此任务尚无所请求的结果');
        const name = kind === 'media' ? 'normalized.mp4' : `${kind}.json`;
        return storedFile(req, env, await jobArtifactKey(env, j, name), kind === 'media' ? 'video/mp4' : 'application/json');
    }
    return null;
}
export async function readPart(req: Request) { const declared = Number(req.headers.get('content-length') || 0); if (declared > PART_SIZE)
    throw new APIError(413, '分片不能超过8MiB'); if (!req.body)
    throw new APIError(422, '分片为空'); const reader = req.body.getReader(), chunks: Uint8Array[] = []; let size = 0; for (;;) {
    const { value, done } = await reader.read();
    if (done)
        break;
    size += value.byteLength;
    if (size > PART_SIZE) {
        await reader.cancel();
        throw new APIError(413, '分片不能超过8MiB');
    }
    chunks.push(value);
} if (!size)
    throw new APIError(422, '分片为空'); const out = new Uint8Array(size); let offset = 0; for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
} return out.buffer; }
