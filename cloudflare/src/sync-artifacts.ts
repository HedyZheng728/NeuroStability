import { APIError, json, sha256, workerAuth } from './auth';
import { requireRow, storedFile, MAX_RESULT_BYTES, jobArtifactKey } from './media';

const names = new Set(['pose.json', 'pose3d.json', 'segmentation.json', 'result.json']);
/** Historical and newly computed JSON only. Never accepts video or filesystem paths. */
export async function syncArtifactRoute(req: Request, env: any): Promise<Response | null> {
    const path = new URL(req.url).pathname;
    const match = /^\/api\/worker\/sync\/artifacts\/([^/]+)\/([^/]+)$/.exec(path);
    if (!match) return null;
    workerAuth(req, env);
    const [, id, name] = match;
    if (!names.has(name)) throw new APIError(409, 'local_media_only: 原视频及渲染视频保留在分析电脑');
    const job = await requireRow(env, 'jobs', id);
    if (!['completed', 'needs_review', 'failed', 'blocked'].includes(job.status)) throw new APIError(409, '分析任务尚未结束');
    const key = await jobArtifactKey(env, job, name);
    if (req.method === 'GET' || req.method === 'HEAD') {
        const response = await storedFile(req, env, key, 'application/json');
        const info = await env.MEDIA.head(key);
        response.headers.set('X-Content-SHA256', info.customMetadata.sha256);
        return response;
    }
    if (req.method !== 'PUT') throw new APIError(405, 'Method not allowed');
    const digest = req.headers.get('X-Content-SHA256');
    if (!digest || !/^[a-f0-9]{64}$/.test(digest)) throw new APIError(422, 'SHA256 无效');
    const existing = await env.MEDIA.head(key);
    if (existing) {
        if (existing.customMetadata?.sha256 === digest) return json({ ok: true, sha256: digest, unchanged: true });
        // Per-job artifacts are immutable. Never replace a different saved analysis.
        throw new APIError(409, '分析文件存在不同版本；两份数据均保留');
    }
    if (Number(req.headers.get('content-length') || 0) > MAX_RESULT_BYTES) throw new APIError(413, 'JSON 结果不能超过16MiB');
    if (!req.body) throw new APIError(422, 'JSON 结果为空');
    const reader = req.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
    for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        total += value.byteLength;
        if (total > MAX_RESULT_BYTES) { await reader.cancel(); throw new APIError(413, 'JSON 结果不能超过16MiB'); }
        chunks.push(value);
    }
    const data = new Uint8Array(total); let offset = 0;
    for (const part of chunks) { data.set(part, offset); offset += part.length; }
    if (await sha256(data.buffer) !== digest) throw new APIError(422, 'JSON 结果校验失败');
    const candidate = `videos/${job.video_id}/jobs/${job.id}/sync-artifacts/${digest}/${name}`;
    await env.MEDIA.put(candidate, data, { httpMetadata: { contentType: 'application/json' }, customMetadata: { sha256: digest } });
    const published = await env.DB.prepare("INSERT INTO job_artifacts(job_id,name,worker_token,storage_key,size_bytes,sha256) VALUES(?,?,'historical-sync',?,?,?) ON CONFLICT(job_id,name,worker_token) DO NOTHING").bind(job.id, name, candidate, total, digest).run();
    if (!published.meta.changes) {
        const winner = await env.DB.prepare("SELECT storage_key,sha256 FROM job_artifacts WHERE job_id=? AND name=? AND worker_token='historical-sync'").bind(job.id, name).first();
        if (winner?.sha256 !== digest) {
            await env.MEDIA.delete(candidate);
            throw new APIError(409, '分析文件存在不同版本；两份数据均保留');
        }
    }
    return json({ ok: true, sha256: digest, size_bytes: total });
}
