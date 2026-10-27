import { APIError, body, choice, epoch, json, now, number, sha256, text, workerAuth } from './auth';
import { compactResult, decodeRow, encode, insert, jobArtifactKey, MAX_RESULT_BYTES, PART_SIZE, readPart, requireRow, rows, storedFile } from './media';
const names = ['normalized.mp4', 'pose.json', 'pose3d.json', 'segmentation.json', 'result.json'];
const terminal = ['completed', 'needs_review', 'failed', 'blocked'];
export async function lease(env: any, id: string, token: string) { const j = await env.DB.prepare("SELECT j.* FROM jobs j JOIN videos v ON v.id=j.video_id WHERE j.id=? AND j.worker_token=? AND j.status='running' AND j.lease_until>? AND v.status!='deleting'").bind(id, token, epoch()).first(); if (!j)
    throw new APIError(409, '任务租约已失效'); return decodeRow(j); }
function leaseToken(req: Request, p?: any) { return text(p?.worker_token || req.headers.get('x-worker-lease'), 80, 1); }
async function describe(env: any, j: any) { if (!j)
    return null; const artifacts: any = {}; for (const name of names) {
    const stored = await env.DB.prepare('SELECT * FROM job_artifacts WHERE job_id=? AND name=? AND worker_token=?').bind(j.id, name, j.worker_token || '').first();
    const key = await jobArtifactKey(env, j, name), head = await env.MEDIA.head(key);
    if (head)
        artifacts[name] = { size_bytes: head.size, sha256: stored?.sha256 || head.customMetadata?.sha256 || null };
} return { ...j, artifacts }; }
function canonical(v: any): string { if (Array.isArray(v))
    return `[${v.map(canonical).join(',')}]`; if (v && typeof v === 'object')
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`; return JSON.stringify(v); }
export async function workerRoute(req: Request, env: any): Promise<Response | null> {
    const url = new URL(req.url), path = url.pathname;
    let m;
    if (!path.startsWith('/api/worker/'))
        return null;
    workerAuth(req, env);
    if (path === '/api/worker/heartbeat' && req.method === 'POST') {
        const p = await body(req, ['worker_id', 'models']), workerId = text(p.worker_id, 100, 1);
        if (!p.models || typeof p.models !== 'object' || Array.isArray(p.models))
            throw new APIError(422, '模型能力无效');
        await env.DB.prepare('INSERT INTO worker_capabilities(worker_id,models,last_seen) VALUES(?,?,?) ON CONFLICT(worker_id) DO UPDATE SET models=excluded.models,last_seen=excluded.last_seen').bind(workerId, JSON.stringify(p.models), epoch()).run();
        return json({ ok: true, lease_seconds: 180 });
    }
    if (path === '/api/worker/claim' && req.method === 'POST') {
        const p = await body(req, ['worker_id', 'backends']);
        text(p.worker_id, 100, 1);
        if (!Array.isArray(p.backends) || p.backends.length < 1 || p.backends.length > 20 || p.backends.some((v: any) => !['rtmpose', 'rtmpose_tracking', 'sam2', 'fsw', 'sample', 'wham', 'preprocess', 'action', 'pose3d', 'review_draft'].includes(v)))
            throw new APIError(422, 'Worker 方法无效');
        const token = crypto.randomUUID(), stamp = now(), slots = p.backends.map(() => '?').join(',');
        const j = await env.DB.prepare(`UPDATE jobs SET status='running',stage='Worker 已领取',worker_token=?,lease_until=?,updated_at=? WHERE id=(SELECT j.id FROM jobs j JOIN videos v ON v.id=j.video_id WHERE (j.status='queued' OR (j.status='running' AND COALESCE(j.lease_until,0)<=?)) AND v.status!='deleting' AND j.backend IN (${slots}) ORDER BY j.created_at,j.id LIMIT 1) AND (status='queued' OR (status='running' AND COALESCE(lease_until,0)<=?)) RETURNING *`).bind(token, epoch() + 180, stamp, epoch(), ...p.backends, epoch()).first();
        if (!j)
            return new Response(null, { status: 204 });
        const job = decodeRow(j), video = await requireRow(env, 'videos', job.video_id), sourceId = job.backend === 'review_draft' ? job.params.job_id : job.params.source_pose_job_id;
        const sourceJob = sourceId ? await requireRow(env, 'jobs', sourceId) : null;
        if (sourceJob && sourceJob.video_id !== video.id)
            throw new APIError(409, '来源不属于此视频');
        const review = (await rows(env, 'SELECT * FROM reviews WHERE video_id=?', [video.id]))[0] || null;
        return json({ job, video, source_job: await describe(env, sourceJob), review });
    }
    if ((m = /^\/api\/worker\/jobs\/([^/]+)\/heartbeat$/.exec(path)) && req.method === 'POST') {
        const p = await body(req, ['worker_token', 'stage', 'progress']), token = leaseToken(req, p);
        await lease(env, m[1], token);
        const stage = p.stage === undefined ? '分析中' : text(p.stage, 100), progress = p.progress === undefined ? 0 : number(p.progress, 0, 99, true);
        const r = await env.DB.prepare("UPDATE jobs SET stage=?,progress=?,lease_until=?,updated_at=? WHERE id=? AND worker_token=? AND status='running' AND lease_until>?").bind(stage, progress, epoch() + 180, now(), m[1], token, epoch()).run();
        if (!r.meta.changes)
            throw new APIError(409, '任务租约已失效');
        return json({ ok: true, lease_until: epoch() + 180 });
    }
    if ((m = /^\/api\/worker\/jobs\/([^/]+)\/source$/.exec(path)) && ['GET', 'HEAD'].includes(req.method)) {
        const job = await lease(env, m[1], leaseToken(req)), video = await requireRow(env, 'videos', job.video_id), artifact = url.searchParams.get('artifact') || 'source';
        let key = video.storage_key, type = 'application/octet-stream', digest = video.sha256;
        if (artifact !== 'source') {
            if (!['normalized.mp4', 'pose.json'].includes(artifact))
                throw new APIError(422, '来源文件无效');
            const sourceId = job.params.source_pose_job_id || (job.backend === 'review_draft' ? job.params.job_id : null);
            if (!sourceId)
                throw new APIError(409, '此任务没有来源分析');
            const source = await requireRow(env, 'jobs', sourceId);
            if (source.video_id !== video.id || !['completed', 'needs_review'].includes(source.status) || !source.result || source.result.synthetic !== false)
                throw new APIError(409, '来源分析无效');
            key = await jobArtifactKey(env, source, artifact);
            type = artifact.endsWith('.json') ? 'application/json' : 'video/mp4';
            const descriptor = await env.MEDIA.head(key);
            digest = descriptor?.customMetadata?.sha256 || '';
        }
        const response = await storedFile(req, env, key, type);
        if (digest)
            response.headers.set('X-Content-SHA256', digest);
        return response;
    }
    if ((m = /^\/api\/worker\/jobs\/([^/]+)\/artifacts\/([^/]+)(?:\/(init|finalize))?$/.exec(path))) {
        const id = m[1], name = m[2], action = m[3];
        if (!names.includes(name))
            throw new APIError(422, '文件名称无效');
        if (action === 'init' && req.method === 'POST') {
            const p = await body(req, ['worker_token', 'size_bytes', 'sha256', 'content_type']), token = leaseToken(req, p), job = await lease(env, id, token), size = number(p.size_bytes, 1, name === 'result.json' ? MAX_RESULT_BYTES : 512 * 1024 * 1024, true);
            if (typeof p.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(p.sha256))
                throw new APIError(422, '文件校验值无效');
            const uploadId = crypto.randomUUID(), key = `videos/${job.video_id}/jobs/${id}/leases/${token}/${uploadId}/${name}`, upload = await env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: name.endsWith('.json') ? 'application/json' : 'video/mp4' }, customMetadata: { sha256: p.sha256 } });
            await insert(env, 'artifact_uploads', { id: uploadId, job_id: id, worker_token: token, name, storage_key: key, multipart_id: upload.uploadId, expires: epoch() + 86400, payload: { size_bytes: size, sha256: p.sha256, parts: {} } }).run();
            return json({ upload_id: uploadId, part_size: PART_SIZE }, 201);
        }
        if (!action && req.method === 'PUT') {
            const token = leaseToken(req), job = await lease(env, id, token), uploadId = url.searchParams.get('upload_id');
            if (!uploadId) {
                const data = await readPart(req), digest = await sha256(data), key = `videos/${job.video_id}/jobs/${id}/leases/${token}/${crypto.randomUUID()}/${name}`;
                await env.MEDIA.put(key, data, { customMetadata: { sha256: digest }, httpMetadata: { contentType: name.endsWith('.json') ? 'application/json' : 'video/mp4' } });
                await lease(env, id, token);
                const saved = await env.DB.prepare("INSERT INTO job_artifacts(job_id,name,worker_token,storage_key,size_bytes,sha256) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM jobs WHERE id=? AND worker_token=? AND status='running' AND lease_until>?) ON CONFLICT(job_id,name,worker_token) DO UPDATE SET storage_key=excluded.storage_key,size_bytes=excluded.size_bytes,sha256=excluded.sha256").bind(id, name, token, key, data.byteLength, digest, id, token, epoch()).run();
                if (!saved.meta.changes)
                    throw new APIError(409, '任务租约已失效');
                return json({ name, size_bytes: data.byteLength, sha256: digest });
            }
            const u = await env.DB.prepare('SELECT * FROM artifact_uploads WHERE id=? AND job_id=? AND worker_token=? AND name=? AND expires>?').bind(uploadId, id, token, name, epoch()).first();
            if (!u)
                throw new APIError(404, '分片上传不存在');
            const p = JSON.parse(u.payload), part = Number(url.searchParams.get('part')), count = Math.ceil(p.size_bytes / PART_SIZE);
            if (!Number.isInteger(part) || part < 1 || part > count)
                throw new APIError(422, '分片编号无效');
            const data = await readPart(req), expected = part === count ? p.size_bytes - PART_SIZE * (part - 1) : PART_SIZE;
            if (data.byteLength !== expected)
                throw new APIError(422, '分片大小不匹配');
            const r = await env.MEDIA.resumeMultipartUpload(u.storage_key, u.multipart_id).uploadPart(part, data);
            await env.DB.prepare("UPDATE artifact_uploads SET payload=json_set(payload,'$.parts',json_patch(json_extract(payload,'$.parts'),json(?))) WHERE id=?").bind(JSON.stringify({ [String(part)]: r }), uploadId).run();
            return json({ part, etag: r.etag, partNumber: part });
        }
        if (action === 'finalize' && req.method === 'POST') {
            const p = await body(req, ['worker_token', 'upload_id', 'parts', 'size_bytes', 'sha256']), token = leaseToken(req, p);
            await lease(env, id, token);
            const u = await env.DB.prepare('SELECT * FROM artifact_uploads WHERE id=? AND job_id=? AND name=? AND worker_token=?').bind(p.upload_id, id, name, token).first();
            if (!u)
                throw new APIError(404, '上传不存在');
            const manifest = JSON.parse(u.payload), parts = Object.values(manifest.parts).sort((a: any, b: any) => a.partNumber - b.partNumber) as any[], count = Math.ceil(manifest.size_bytes / PART_SIZE);
            if (p.size_bytes !== manifest.size_bytes || p.sha256 !== manifest.sha256 || parts.length !== count || parts.some((r: any, i: number) => r.partNumber !== i + 1))
                throw new APIError(422, '文件分片校验失败');
            let obj = await env.MEDIA.head(u.storage_key);
            if (!obj)
                obj = await env.MEDIA.resumeMultipartUpload(u.storage_key, u.multipart_id).complete(parts);
            if (obj.size !== manifest.size_bytes)
                throw new APIError(422, '文件大小校验失败');
            await lease(env, id, token);
            const saved = await env.DB.prepare("INSERT INTO job_artifacts(job_id,name,worker_token,storage_key,size_bytes,sha256) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM jobs WHERE id=? AND worker_token=? AND status='running' AND lease_until>?) ON CONFLICT(job_id,name,worker_token) DO UPDATE SET storage_key=excluded.storage_key,size_bytes=excluded.size_bytes,sha256=excluded.sha256").bind(id, name, token, u.storage_key, obj.size, manifest.sha256, id, token, epoch()).run();
            if (!saved.meta.changes)
                throw new APIError(409, '任务租约已失效');
            return json({ name, size_bytes: obj.size, sha256: manifest.sha256 });
        }
    }
    if ((m = /^\/api\/worker\/jobs\/([^/]+)\/complete$/.exec(path)) && req.method === 'POST') {
        const p = await body(req, ['worker_token', 'status', 'stage', 'metadata', 'result', 'error', 'draft', 'source_sha256', 'result_artifact'], 1792 * 1024), token = leaseToken(req, p), id = m[1], digest = await sha256(canonical(p));
        const previous = await env.DB.prepare('SELECT * FROM worker_completions WHERE job_id=?').bind(id).first();
        if (previous) {
            if (previous.worker_token !== token || previous.payload_sha256 !== digest)
                throw new APIError(409, '任务已由不同结果完成');
            return json(JSON.parse(previous.response));
        }
        const job = await lease(env, id, token), status = choice(p.status, terminal), stage = text(p.stage, 100, 0, status === 'failed' ? '分析失败' : '分析完成');
        const video = await requireRow(env, 'videos', job.video_id);
        if (!['failed', 'blocked'].includes(status) && job.backend !== 'review_draft') {
            if (!video.sha256 && (typeof p.source_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(p.source_sha256)))
                throw new APIError(422, '原视频校验值缺失');
            if (video.sha256 && p.source_sha256 && p.source_sha256 !== video.sha256)
                throw new APIError(422, '原视频校验值不匹配');
        }
        if (p.error !== null && p.error !== undefined)
            text(p.error, 15000);
        if (!['failed', 'blocked'].includes(status)) {
            if (job.backend === 'review_draft') {
                if (!p.draft || typeof p.draft !== 'object' || typeof p.draft.text !== 'string' || !p.draft.text.trim())
                    throw new APIError(422, '语言草稿缺失');
            }
            else {
                if (!p.metadata || typeof p.metadata !== 'object' || Array.isArray(p.metadata))
                    throw new APIError(422, '视频预处理信息缺失');
                if (job.backend !== 'preprocess' && (!p.result || typeof p.result !== 'object' || Array.isArray(p.result) || p.result.synthetic !== false))
                    throw new APIError(422, '真实分析结果缺失');
                const required = ['normalized.mp4', ...(['rtmpose', 'rtmpose_tracking'].includes(job.backend) ? ['pose.json'] : job.backend === 'pose3d' ? ['pose3d.json'] : job.backend === 'sam2' ? ['segmentation.json'] : [])];
                for (const name of required) {
                    const a = await env.DB.prepare('SELECT storage_key,size_bytes FROM job_artifacts WHERE job_id=? AND name=? AND worker_token=?').bind(id, name, token).first();
                    if (!a || !(await env.MEDIA.head(a.storage_key)))
                        throw new APIError(422, `分析文件缺失: ${name}`);
                }
            }
        }
        let storedResult = p.result ?? null;
        if (storedResult && Object.hasOwn(storedResult, '_full_result_key')) throw new APIError(422, '不能指定内部分析结果引用');
        if (p.result_artifact !== undefined && typeof p.result_artifact !== 'boolean') throw new APIError(422, '完整分析结果标记无效');
        if (p.result_artifact) {
            if (['failed', 'blocked'].includes(status) || !storedResult || typeof storedResult !== 'object' || Array.isArray(storedResult)) throw new APIError(422, '完整分析结果引用无效');
            const manifest = await env.DB.prepare('SELECT storage_key,size_bytes,sha256 FROM job_artifacts WHERE job_id=? AND name=? AND worker_token=?').bind(id, 'result.json', token).first();
            if (!manifest || manifest.size_bytes > MAX_RESULT_BYTES) throw new APIError(422, '完整分析结果文件缺失或过大');
            const artifact = await env.MEDIA.get(manifest.storage_key);
            if (!artifact || artifact.size !== manifest.size_bytes) throw new APIError(422, '完整分析结果文件大小不匹配');
            const data = await artifact.arrayBuffer();
            if (await sha256(data) !== manifest.sha256) throw new APIError(422, '完整分析结果文件校验失败');
            let fullResult;
            try { fullResult = JSON.parse(new TextDecoder().decode(data)); } catch { throw new APIError(422, '完整分析结果 JSON 无效'); }
            if (!fullResult || typeof fullResult !== 'object' || Array.isArray(fullResult) || Object.hasOwn(fullResult, '_full_result_key') || canonical(compactResult(fullResult)) !== canonical(storedResult)) throw new APIError(422, '完整分析结果与摘要不一致');
            storedResult = { ...storedResult, _full_result_key: manifest.storage_key };
        }
        // Leave headroom below D1's 2 MB row limit, including all pre-existing job fields.
        const rowBytes = new TextEncoder().encode(JSON.stringify({ ...job, metadata: p.metadata ?? job.metadata, result: storedResult, error: p.error ?? null })).byteLength;
        if (rowBytes > 1792 * 1024) throw new APIError(413, '分析记录过大，请将完整时序结果上传 result.json');
        const response = { ok: true, job_id: id, status }, stamp = now(), batch: any[] = [env.DB.prepare("INSERT INTO worker_completions(job_id,worker_token,payload_sha256,response) SELECT id,?,?,? FROM jobs WHERE id=? AND status='running' AND worker_token=? AND lease_until>? AND EXISTS(SELECT 1 FROM videos WHERE videos.id=jobs.video_id AND videos.status!='deleting')").bind(token, digest, JSON.stringify(response), id, token, epoch()), env.DB.prepare('UPDATE jobs SET status=?,stage=?,progress=?,metadata=?,result=?,error=?,lease_until=NULL,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM worker_completions c WHERE c.job_id=jobs.id AND c.worker_token=? AND c.payload_sha256=?)').bind(status, stage, ['failed', 'blocked'].includes(status) ? job.progress : 100, encode(p.metadata ?? job.metadata), encode(storedResult), p.error ?? null, stamp, id, token, digest)];
        if (!['failed', 'blocked'].includes(status) && job.backend !== 'review_draft' && !video.sha256)
            batch.push(env.DB.prepare("UPDATE videos SET sha256=? WHERE id=? AND sha256='' AND EXISTS(SELECT 1 FROM worker_completions WHERE job_id=? AND worker_token=? AND payload_sha256=?)").bind(p.source_sha256, job.video_id, id, token, digest));
        if (job.backend === 'review_draft' && !['failed', 'blocked'].includes(status)) {
            const d = p.draft;
            const source = await requireRow(env, 'jobs', job.params.job_id);
            batch.push(env.DB.prepare('INSERT INTO review_drafts(id,video_id,job_id,provider,model,synthetic,text,facts,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM worker_completions WHERE job_id=? AND worker_token=? AND payload_sha256=?)').bind(job.params.draft_id || crypto.randomUUID(), job.video_id, source.id, 'llm', text(d.model, 100, 0, 'local-language-model'), Number(!!source.result?.synthetic), text(d.text, 100000, 1), JSON.stringify(d.facts || {}), stamp, id, token, digest));
        }
        try {
            const results = await env.DB.batch(batch);
            if (!results[0].meta.changes)
                throw new APIError(409, '任务租约已失效');
        }
        catch (e) {
            if (e instanceof APIError)
                throw e;
            const complete = await env.DB.prepare('SELECT * FROM worker_completions WHERE job_id=?').bind(id).first();
            if (complete && complete.worker_token === token && complete.payload_sha256 === digest)
                return json(JSON.parse(complete.response));
            throw new APIError(409, '任务提交冲突，请重新核对租约');
        }
        return json(response);
    }
    throw new APIError(404, 'Worker 接口不存在');
}
