import { D1ResultStore } from './result-store';
import { syncRoute } from './sync';
import { syncArtifactRoute } from './sync-artifacts';
import { APIError, authenticate, body, boolean, challenge, choice, cookie, date, json, login, now, number, text } from './auth';
import { decodeRow, encode, insert, mediaRoute, removePrefix, requireRow, resultHydrate, resultSummary, rows } from './media';
import { workerRoute } from './jobs';
import { acceptanceError, analyticsSummary, dateFilters, exportCsv, exportZip, factsFor, planningSummary, readSnapshot, rulesDraft, workspaceToday } from './analytics';
export interface Env {
    DB: any;
    MEDIA?: any;
    ARENA_RESULTS_ONLY?: string;
    ASSETS?: {
        fetch: (r: Request) => Promise<Response>;
    };
    ARENA_WORKER_TOKEN?: string;
    ARENA_PUBLIC_URL?: string;
    ARENA_TIMEZONE?: string;
}
const categories = ['stability', 'footwork', 'attack', 'defense'], videoCategories = [...categories, 'mixed'];
const backends = ['rtmpose', 'rtmpose_tracking', 'sam2', 'fsw', 'sample', 'wham', 'preprocess', 'action', 'pose3d'];
async function assessed(env: Env, found: any[], hydrate = true) { if (!found.length)
    return []; const assessments = await rows(env, 'SELECT * FROM analysis_assessments WHERE job_id IN (SELECT value FROM json_each(?))', [JSON.stringify(found.map(j => j.id))]); const byJob = new Map(assessments.map(a => [a.job_id, a])); return Promise.all(found.map(async j => ({ ...(hydrate ? await resultHydrate(env, j) : resultSummary(j)), assessment: byJob.get(j.id) || null }))); }
async function videoRows(env: Env, filter: {
    id?: string;
    category?: string;
    athlete_id?: string;
} = {}) {
    const conditions: string[] = [], args: any[] = [];
    for (const [k, v] of Object.entries(filter)) {
        if (v) {
            conditions.push(`${k === 'athlete_id' ? 'a.id' : `v.${k}`}=?`);
            args.push(v);
        }
    }
    const found = await rows(env, `SELECT v.*,a.name AS athlete_name,s.date AS session_date FROM videos v JOIN sessions s ON s.id=v.session_id JOIN athletes a ON a.id=s.athlete_id ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''} ORDER BY v.created_at DESC`, args);
    if (!found.length)
        return found;
    const ids = JSON.stringify(found.map(v => v.id)), responses = await env.DB.batch([
        env.DB.prepare('SELECT video_id,score,confirmed FROM manual_scores WHERE video_id IN (SELECT value FROM json_each(?))').bind(ids),
        env.DB.prepare('SELECT j.* FROM jobs j WHERE j.video_id IN (SELECT value FROM json_each(?)) AND j.id=(SELECT latest.id FROM jobs latest WHERE latest.video_id=j.video_id ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1)').bind(ids),
        env.DB.prepare('SELECT * FROM reviews WHERE video_id IN (SELECT value FROM json_each(?))').bind(ids)
    ]);
    const scores = new Map(responses[0].results.map((s: any) => [s.video_id, decodeRow(s)])), jobs = new Map((await assessed(env, responses[1].results.map(decodeRow), Boolean(filter.id))).map(j => [j.video_id, j])), reviews = new Map(responses[2].results.map((r: any) => [r.video_id, decodeRow(r)]));
    for (const v of found) {
        const score: any = scores.get(v.id);
        v.score = score ? { score: score.score, confirmed: score.confirmed } : null;
        v.latest_job = jobs.get(v.id) || null;
        v.review = reviews.get(v.id) || null;
        delete v.storage_key;
        if (env.ARENA_RESULTS_ONLY === 'true' || env.MEDIA?.resultsOnly) v.media_location = 'local';
    }
    return found;
}
async function getVideo(env: Env, id: string) { await requireRow(env, 'videos', id); return (await videoRows(env, { id }))[0]; }
async function planRows(env: Env, id?: string, athleteId?: string) { const found = await rows(env, `SELECT p.*,a.name AS athlete_name FROM training_plans p JOIN athletes a ON a.id=p.athlete_id ${id ? 'WHERE p.id=?' : athleteId ? 'WHERE p.athlete_id=?' : ''} ORDER BY p.date DESC,p.created_at DESC`, id ? [id] : athleteId ? [athleteId] : []); return found.map(p => ({ ...p, status: p.session_id ? 'completed' : p.status })); }
function sessionPayload(p: any) { return { athlete_id: text(p.athlete_id, 36, 1), date: date(p.date), objective: text(p.objective, 2000, 0, ''), duration_min: number(p.duration_min ?? 0, 0, 1440, true), rpe: p.rpe == null ? null : number(p.rpe, 0, 10, true), notes: text(p.notes, 5000, 0, '') }; }
async function update(env: Env, table: string, id: string, data: any) { const keys = Object.keys(data); await env.DB.prepare(`UPDATE ${table} SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`).bind(...keys.map(k => encode(data[k])), id).run(); }
async function history(env: Env, id: string, parent: string, current: string, historyTable: string, foreignKey: string) { await requireRow(env, parent, id); const result = await env.DB.batch([env.DB.prepare(`SELECT * FROM ${current} WHERE ${foreignKey}=?`).bind(id), env.DB.prepare(`SELECT * FROM ${historyTable} WHERE ${foreignKey}=? ORDER BY created_at,id`).bind(id)]); return { current: result[0].results.map(decodeRow)[0] || null, history: result[1].results.map(decodeRow) }; }
async function saveHistory(env: Env, table: string, historyTable: string, fk: string, id: string, record: any) {
    const keys = Object.keys(record), values = keys.map(k => encode(record[k]));
    // The upsert and snapshot use a single D1 transaction, including the stored row ID.
    await env.DB.batch([env.DB.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')}) ON CONFLICT(${fk}) DO UPDATE SET ${keys.filter(k => k !== 'id').map(k => `${k}=excluded.${k}`).join(',')}`).bind(...values), env.DB.prepare(`INSERT INTO ${historyTable}(id,${fk},snapshot,created_at) SELECT ?,?,json_object(${keys.map(k => `'${k}',${k === 'confirmed' ? "json(CASE WHEN confirmed THEN 'true' ELSE 'false' END)" : k}`).join(',')}),? FROM ${table} WHERE ${fk}=?`).bind(crypto.randomUUID(), id, record.updated_at, id)]);
    return (await rows(env, `SELECT * FROM ${table} WHERE ${fk}=?`, [id]))[0];
}
async function summarySnapshot(env: Env, filter: any) {
    const snapshot = await readSnapshot(env.DB, filter);
    for (const entries of Object.values(snapshot)) for (const row of entries) {
        if (row.result && typeof row.result === 'object') delete row.result._full_result_key;
    }
    return snapshot;
}
async function filters(env: Env, url: URL) { const athleteId = url.searchParams.get('athlete_id'); if (athleteId)
    await requireRow(env, 'athletes', athleteId); const today = workspaceToday(env.ARENA_TIMEZONE || 'Asia/Shanghai'); let start = url.searchParams.get('start'), end = url.searchParams.get('end'); if (start)
    date(start); if (end)
    date(end); if (!start) {
    const q = await env.DB.prepare(`SELECT MIN(date) AS value FROM sessions WHERE date<=?${athleteId ? ' AND athlete_id=?' : ''}`).bind(...(athleteId ? [end || today, athleteId] : [end || today])).first();
    start = q?.value || null;
} return { filter: dateFilters(start || undefined, end || undefined, athleteId || undefined, today), today }; }
async function modelStatus(env: Env) { const capabilities = await rows(env, 'SELECT * FROM worker_capabilities ORDER BY last_seen DESC'); const online = capabilities.filter(c => c.last_seen > Math.floor(Date.now() / 1000) - 90); const keys: any = { rtmpose: 'rtmpose', rtmpose_tracking: 'tracking', sam2: 'sam2', action: 'action', pose3d: 'pose3d', fsw: 'fsw', wham: 'wham', preprocess: 'preprocessing', review_draft: 'llm' }; const result: any = { sample: { ready: false, available: false, synthetic: true, reason: '合成样例模式已禁用' }, worker: { ready: online.length > 0, available: online.length > 0, last_seen: capabilities[0]?.last_seen || null } }; for (const [b, key] of Object.entries(keys)) {
    const advertised = online.map(w => w.models?.[key as string] || w.models?.[b]).find(Boolean);
    const value = advertised && typeof advertised === 'object' ? advertised : { ready: false, available: false, reason: online.length ? '本地 Worker 未报告此方法可用' : '本地 Worker 离线；已保存结果仍可查看' };
    const all = await rows(env, "SELECT video_id,result,updated_at,status FROM jobs WHERE backend=? ORDER BY updated_at", [b]);
    const successful = all.filter(j => ['completed', 'needs_review'].includes(j.status) && j.result?.synthetic === false);
    const latest = new Map(successful.map(j => [j.video_id, j]));
    result[key as string] = { ...value, ready: value.ready === true || value.available === true, available: value.ready === true || value.available === true, processed_jobs: successful.length, processed_videos: latest.size, last_processed_at: successful.at(-1)?.updated_at || null, active_jobs: all.filter(j => ['running', 'queued'].includes(j.status)).length };
    if (b === 'sam2')
        result[key as string].segmented_frames = [...latest.values()].reduce((a, j) => a + (j.result.segmentation?.segmented_frames || 0), 0);
    if (b === 'rtmpose_tracking') {
        result[key as string].track_count = [...latest.values()].reduce((a, j) => a + (j.result.tracking?.track_count || 0), 0);
        result[key as string].joint_observed_videos = [...latest.values()].filter(j => j.result.kinematics?.tracks?.length).length;
    }
    if (b === 'pose3d')
        result[key as string].reconstructed_frames = [...latest.values()].reduce((a, j) => a + (j.result.pose3d?.frame_count || 0), 0);
} result.rtmpose_tracking = { ...result.tracking }; const languageDrafts = await rows(env, "SELECT video_id,model,facts FROM review_drafts WHERE provider='llm' AND synthetic=0"); const validDrafts = languageDrafts.filter(d => d.model !== 'Qwen/Qwen2.5-1.5B-Instruct' || d.facts?.language_output?.method === 'extractive-source-v1'); result.llm.processed_jobs = validDrafts.length; result.llm.processed_videos = new Set(validDrafts.map(d => d.video_id)).size; return result; }
async function api(req: Request, env: Env) {
    const url = new URL(req.url), path = url.pathname, method = req.method;
    let m: any;
    if (path === '/healthz' && method === 'GET') {
        await env.DB.prepare('SELECT version FROM schema_version').first();
        return json({ status: 'ok', version: '0.1.0', authentication: 'browser-proof-v1' });
    }
    if (path === '/api/login/challenge' && method === 'POST')
        return challenge(req, env);
    if (path === '/api/login' && method === 'POST')
        return login(req, env);
    if (path.startsWith('/api/worker/'))
        return await syncArtifactRoute(req, env) || await syncRoute(req, env) || workerRoute(req, env);
    if (!path.startsWith('/api/')) {
        if (env.ASSETS) {
            const response = await env.ASSETS.fetch(req);
            if (response.status === 404 && !path.includes('.'))
                return env.ASSETS.fetch(new Request(new URL('/index.html', req.url), req));
            return response;
        }
        throw new APIError(404, '页面不存在');
    }
    const user = await authenticate(req, env);
    if (path === '/api/me' && method === 'GET')
        return json({ username: user.username, csrf: user.csrf, timezone: env.ARENA_TIMEZONE || 'Asia/Shanghai' });
    if (path === '/api/logout' && method === 'POST') {
        await env.DB.prepare('DELETE FROM auth_sessions WHERE id=?').bind(user.id).run();
        return new Response(null, { status: 204, headers: { 'set-cookie': cookie(req, '', 0) } });
    }
    const media = await mediaRoute(req, env);
    if (media)
        return media;
    if (path === '/api/models' && method === 'GET')
        return json(await modelStatus(env));
    if (path === '/api/athletes' && method === 'GET')
        return json(await rows(env, 'SELECT * FROM athletes ORDER BY created_at DESC'));
    if ((path === '/api/athletes' && method === 'POST') || ((m = /^\/api\/athletes\/([^/]+)$/.exec(path)) && method === 'PUT')) {
        const p = await body(req, ['name', 'level']), data = { name: text(p.name, 100, 1), level: text(p.level, 100, 0, '') };
        if (method === 'PUT') {
            await requireRow(env, 'athletes', m[1]);
            await update(env, 'athletes', m[1], data);
            return json(await requireRow(env, 'athletes', m[1]));
        }
        const row = { id: crypto.randomUUID(), ...data, created_at: now() };
        await insert(env, 'athletes', row).run();
        return json(row, 201);
    }
    if (path === '/api/sessions' && method === 'GET')
        return json(await rows(env, 'SELECT * FROM sessions ORDER BY date DESC,created_at DESC'));
    if (path === '/api/sessions' && method === 'POST') {
        const p = await body(req, ['athlete_id', 'date', 'objective', 'duration_min', 'rpe', 'notes', 'plan_id']), data = sessionPayload(p);
        await requireRow(env, 'athletes', data.athlete_id);
        const row = { id: crypto.randomUUID(), ...data, created_at: now() };
        if (p.plan_id != null) {
            const id = text(p.plan_id, 36, 1), plan = await requireRow(env, 'training_plans', id);
            if (plan.status !== 'planned' || plan.session_id)
                throw new APIError(409, '训练计划已取消或已关联场次');
            if (plan.athlete_id !== data.athlete_id)
                throw new APIError(409, '计划与场次的运动员必须一致');
            // A conditional INSERT followed by conditional link cannot leave an unlinked session after a concurrent cancellation.
            const keys = Object.keys(row), result = await env.DB.batch([env.DB.prepare(`INSERT INTO sessions(${keys.join(',')}) SELECT ${keys.map(() => '?').join(',')} WHERE EXISTS(SELECT 1 FROM training_plans WHERE id=? AND status='planned' AND session_id IS NULL AND athlete_id=?)`).bind(...keys.map(k => (row as any)[k]), id, data.athlete_id), env.DB.prepare("UPDATE training_plans SET session_id=? WHERE id=? AND status='planned' AND session_id IS NULL AND EXISTS(SELECT 1 FROM sessions WHERE id=?)").bind(row.id, id, row.id)]);
            if (!result[0].meta.changes)
                throw new APIError(409, '训练计划已取消或已关联场次');
        }
        else
            await insert(env, 'sessions', row).run();
        return json(row, 201);
    }
    if ((m = /^\/api\/sessions\/([^/]+)$/.exec(path)) && method === 'PUT') {
        const p = await body(req, ['athlete_id', 'date', 'objective', 'duration_min', 'rpe', 'notes']), data = sessionPayload(p);
        await requireRow(env, 'sessions', m[1]);
        await requireRow(env, 'athletes', data.athlete_id);
        const linked = await env.DB.prepare('SELECT athlete_id FROM training_plans WHERE session_id=?').bind(m[1]).first();
        if (linked && linked.athlete_id !== data.athlete_id)
            throw new APIError(409, '已关联计划的场次不能更换运动员');
        await update(env, 'sessions', m[1], data);
        return json(await requireRow(env, 'sessions', m[1]));
    }
    if (path === '/api/plans' && method === 'GET') {
        const id = url.searchParams.get('athlete_id') || undefined;
        if (id)
            await requireRow(env, 'athletes', id);
        return json(await planRows(env, undefined, id));
    }
    if (path === '/api/plans' && method === 'POST') {
        const p = await body(req, ['athlete_id', 'date', 'category', 'objective', 'planned_minutes']), data = { athlete_id: text(p.athlete_id, 36, 1), date: date(p.date), category: choice(p.category, categories), objective: text(p.objective, 2000, 0, ''), planned_minutes: number(p.planned_minutes, 1, 1440, true) };
        await requireRow(env, 'athletes', data.athlete_id);
        const row = { id: crypto.randomUUID(), ...data, status: 'planned', session_id: null, created_at: now() };
        await insert(env, 'training_plans', row).run();
        return json((await planRows(env, row.id))[0], 201);
    }
    if ((m = /^\/api\/plans\/([^/]+)$/.exec(path)) && method === 'PATCH') {
        const p = await body(req, ['status']), status = choice(p.status, ['planned', 'cancelled']);
        await requireRow(env, 'training_plans', m[1]);
        const changed = await env.DB.prepare('UPDATE training_plans SET status=? WHERE id=? AND session_id IS NULL').bind(status, m[1]).run();
        if (!changed.meta.changes)
            throw new APIError(409, '已关联场次的训练计划不能更改状态');
        return json((await planRows(env, m[1]))[0]);
    }
    if (path === '/api/videos' && method === 'GET') {
        const category = url.searchParams.get('category') || undefined;
        if (category)
            choice(category, videoCategories);
        return json(await videoRows(env, { category, athlete_id: url.searchParams.get('athlete_id') || undefined }));
    }
    if ((m = /^\/api\/videos\/([^/]+)$/.exec(path)) && method === 'GET')
        return json(await getVideo(env, m[1]));
    if ((m = /^\/api\/videos\/([^/]+)\/category$/.exec(path)) && method === 'PATCH') {
        const p = await body(req, ['category']);
        await requireRow(env, 'videos', m[1]);
        await update(env, 'videos', m[1], { category: choice(p.category, videoCategories) });
        return json(await getVideo(env, m[1]));
    }
    if ((m = /^\/api\/videos\/([^/]+)$/.exec(path)) && method === 'DELETE') {
        const id = m[1];
        await requireRow(env, 'videos', id);
        const result = await env.DB.prepare("UPDATE videos SET status='deleting' WHERE id=? AND NOT EXISTS(SELECT 1 FROM jobs WHERE video_id=? AND status IN ('running','queued'))").bind(id, id).run();
        if (!result.meta.changes)
            throw new APIError(409, '任务排队或运行中，请结束后删除');
        await removePrefix(env, `videos/${id}/`);
        await env.DB.prepare("DELETE FROM videos WHERE id=? AND status='deleting'").bind(id).run();
        return new Response(null, { status: 204 });
    }
    if ((m = /^\/api\/videos\/([^/]+)\/jobs$/.exec(path)) && method === 'POST') {
        const id = m[1], p = await body(req, ['backend', 'sample_acknowledged', 'source_pose_job_id', 'target_track_id', 'roi', 'start_sec', 'end_sec']), backend = choice(p.backend, backends, 'rtmpose');
        if (backend === 'sample')
            throw new APIError(409, '合成样例模式已禁用');
        boolean(p.sample_acknowledged);
        const params: any = { source_pose_job_id: p.source_pose_job_id == null ? null : text(p.source_pose_job_id, 36, 1), target_track_id: p.target_track_id == null ? null : number(p.target_track_id, 1, 100000, true), roi: p.roi ?? null, start_sec: number(p.start_sec ?? 0, 0, Number.MAX_VALUE), end_sec: p.end_sec == null ? null : number(p.end_sec, Number.MIN_VALUE, Number.MAX_VALUE) };
        if (params.end_sec !== null && params.end_sec <= params.start_sec)
            throw new APIError(422, '片段终点必须晚于起点');
        if (params.target_track_id !== null && !params.source_pose_job_id)
            throw new APIError(422, '选择目标轨迹须同时指定来源分析');
        if (params.roi !== null) {
            if (['action', 'pose3d'].includes(backend) || !Array.isArray(params.roi) || params.roi.length !== 4 || params.roi.some((v: any) => typeof v !== 'number' || !Number.isFinite(v)) || Math.min(...params.roi) < 0 || params.roi[2] <= 0 || params.roi[3] <= 0 || params.roi[0] + params.roi[2] > 1 || params.roi[1] + params.roi[3] > 1)
                throw new APIError(422, 'ROI 须为图像内归一化 [x,y,w,h]');
        }
        const video = await requireRow(env, 'videos', id);
        if (video.status === 'deleting')
            throw new APIError(409, '视频正在删除');
        if (params.source_pose_job_id) {
            if (!['rtmpose_tracking', 'pose3d'].includes(backend) || params.roi !== null || params.start_sec !== 0 || params.end_sec !== null)
                throw new APIError(422, '目标轨迹复用来源片段，不能更改时间或选区');
            if (backend === 'rtmpose_tracking' && params.target_track_id === null)
                throw new APIError(422, '二维目标复算须明确选择轨迹');
            const source = await requireRow(env, 'jobs', params.source_pose_job_id);
            if (source.video_id !== id || source.backend !== 'rtmpose_tracking' || !['completed', 'needs_review'].includes(source.status) || source.result?.synthetic !== false)
                throw new APIError(422, '来源必须是此视频已完成的人物轨迹分析');
            if (backend === 'pose3d' && params.target_track_id === null)
                params.target_track_id = source.params?.target_track_id ?? null;
            const offset = source.metadata?.time_offset, duration = source.metadata?.duration;
            if (typeof offset !== 'number' || typeof duration !== 'number' || !Number.isFinite(offset) || !Number.isFinite(duration) || offset < 0 || duration <= 0)
                throw new APIError(422, '来源片段的时间信息无效');
            params.start_sec = offset;
            params.end_sec = offset + duration;
            if (params.target_track_id !== null && !source.result.tracking?.tracks?.some((t: any) => t.track_id === params.target_track_id))
                throw new APIError(422, '来源分析中没有此轨迹');
        }
        const row = { id: crypto.randomUUID(), video_id: id, backend, status: 'queued', stage: '等待 Worker', progress: 0, params, metadata: null, result: null, error: null, worker_token: null, lease_until: null, created_at: now(), updated_at: now() };
        try {
            const keys = Object.keys(row);
            const r = await env.DB.prepare(`INSERT INTO jobs(${keys.join(',')}) SELECT ${keys.map(() => '?').join(',')} WHERE EXISTS(SELECT 1 FROM videos WHERE id=? AND status!='deleting')`).bind(...keys.map(k => encode((row as any)[k])), id).run();
            if (!r.meta.changes)
                throw new APIError(409, '视频正在删除');
        }
        catch (e) {
            if (e instanceof APIError)
                throw e;
            throw new APIError(409, '已有排队或运行中的分析任务');
        }
        return json(row, 202);
    }
    if ((m = /^\/api\/jobs\/([^/]+)\/cancel$/.exec(path)) && method === 'POST') {
        const id = m[1];
        const changed = await env.DB.prepare("UPDATE jobs SET status='failed',stage='Cancelled',error='Cancelled',worker_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status IN ('queued','running') RETURNING *").bind(now(), id).first();
        if (!changed) {
            await requireRow(env, 'jobs', id);
            throw new APIError(409, '任务已结束，不能取消');
        }
        return json((await assessed(env, [decodeRow(changed)]))[0]);
    }
    if ((m = /^\/api\/jobs\/([^/]+)$/.exec(path)) && method === 'GET')
        return json((await assessed(env, [await requireRow(env, 'jobs', m[1])]))[0]);
    if ((m = /^\/api\/jobs\/([^/]+)\/assessment$/.exec(path)) && method === 'GET')
        return json(await history(env, m[1], 'jobs', 'analysis_assessments', 'analysis_assessment_history', 'job_id'));
    if ((m = /^\/api\/jobs\/([^/]+)\/assessment$/.exec(path)) && method === 'PUT') {
        const id = m[1], job = await requireRow(env, 'jobs', id), p = await body(req, ['decision', 'subject_role', 'reason']), decision = choice(p.decision, ['accepted', 'excluded', 'superseded', 'pending']), role = choice(p.subject_role, ['athlete', 'coach', 'unknown']), reason = text(p.reason, 5000, 0, '');
        if (decision !== 'pending' && !reason)
            throw new APIError(422, '关闭分析审核需要填写判断依据');
        if (!['rtmpose', 'rtmpose_tracking', 'sam2'].includes(job.backend) || !['completed', 'needs_review'].includes(job.status) || job.result?.synthetic !== false)
            throw new APIError(409, '仅可审核已产出结果的真实姿态或人物分割分析');
        if (decision === 'accepted') {
            const error = acceptanceError(job, role);
            if (error)
                throw new APIError(409, error);
        }
        const record = { id: crypto.randomUUID(), job_id: id, decision, subject_role: role, reason, reviewer: user.username, updated_at: now() };
        return json(await saveHistory(env, 'analysis_assessments', 'analysis_assessment_history', 'job_id', id, record));
    }
    if ((m = /^\/api\/videos\/([^/]+)\/events$/.exec(path)) && method === 'GET') {
        await requireRow(env, 'videos', m[1]);
        return json(await rows(env, 'SELECT * FROM events WHERE video_id=? ORDER BY start_sec', [m[1]]));
    }
    if ((m = /^\/api\/videos\/([^/]+)\/events$/.exec(path)) && method === 'POST') {
        const id = m[1];
        await requireRow(env, 'videos', id);
        const p = await body(req, ['source_job_id', 'start_sec', 'end_sec', 'label', 'actor', 'outcome', 'notes']), data = { source_job_id: p.source_job_id == null ? null : text(p.source_job_id, 36, 1), start_sec: number(p.start_sec, 0, 300), end_sec: number(p.end_sec, Number.MIN_VALUE, 300), label: text(p.label, 100, 1), actor: choice(p.actor, ['athlete', 'opponent', 'unknown'], 'unknown'), outcome: text(p.outcome, 100, 0, '待确认'), notes: text(p.notes, 3000, 0, '') };
        if (data.end_sec <= data.start_sec)
            throw new APIError(422, '片段终点必须晚于起点');
        const jobs = await rows(env, 'SELECT * FROM jobs WHERE video_id=? ORDER BY created_at DESC', [id]), known = jobs.find(j => typeof j.metadata?.source_duration === 'number' && Number.isFinite(j.metadata.source_duration));
        if (!known)
            throw new APIError(409, '请先完成视频预处理后标注；无需安装分析模型');
        if (data.end_sec > known.metadata.source_duration + .05)
            throw new APIError(422, '事件超出原视频时长');
        if (data.source_job_id) {
            const source = await requireRow(env, 'jobs', data.source_job_id);
            if (source.video_id !== id || !['action', 'fsw'].includes(source.backend) || !['completed', 'needs_review'].includes(source.status) || source.result?.kind !== 'recognition' || source.result?.synthetic !== false)
                throw new APIError(422, '动作来源须为此视频已完成的真实识别任务');
            const duration = source.metadata?.duration, offset = source.metadata?.time_offset;
            if (typeof duration !== 'number' || typeof offset !== 'number' || !Number.isFinite(duration) || !Number.isFinite(offset) || duration <= 0)
                throw new APIError(409, '动作来源缺少有效的时间信息');
            if (data.start_sec < offset - .05 || data.end_sec > offset + duration + .05)
                throw new APIError(422, '标注超出来源分析片段的时间范围');
        }
        const row = { id: crypto.randomUUID(), video_id: id, ...data, created_by: user.username, created_at: now() };
        await insert(env, 'events', row).run();
        return json(row, 201);
    }
    if ((m = /^\/api\/events\/([^/]+)$/.exec(path)) && method === 'DELETE') {
        await requireRow(env, 'events', m[1]);
        await env.DB.prepare('DELETE FROM events WHERE id=?').bind(m[1]).run();
        return new Response(null, { status: 204 });
    }
    if ((m = /^\/api\/videos\/([^/]+)\/review-drafts$/.exec(path)) && method === 'POST') {
        const id = m[1];
        await requireRow(env, 'videos', id);
        const p = await body(req, ['job_id', 'provider', 'language']), job = await requireRow(env, 'jobs', text(p.job_id, 36, 1)), provider = choice(p.provider, ['rules', 'llm'], 'rules'), language = choice(p.language, ['en', 'zh'], 'zh');
        if (job.video_id !== id || !job.result)
            throw new APIError(409, '请选择属于当前视频且已有结果的分析任务');
        const facts = factsFor(job);
        if (provider === 'llm') {
            const saved = (await rows(env, 'SELECT * FROM reviews WHERE video_id=? AND confirmed=1', [id]))[0];
            if (saved)
                facts.recorded_review = { source: 'saved_review', observations: saved.observations, next_action: saved.next_action };
            const draftId = crypto.randomUUID(), queued = { id: crypto.randomUUID(), video_id: id, backend: 'review_draft', status: 'queued', stage: '等待本地语言模型', progress: 0, params: { job_id: job.id, provider, language, draft_id: draftId, facts }, metadata: null, result: null, error: null, worker_token: null, lease_until: null, created_at: now(), updated_at: now() };
            try {
                const keys = Object.keys(queued);
                const changed = await env.DB.prepare(`INSERT INTO jobs(${keys.join(',')}) SELECT ${keys.map(() => '?').join(',')} WHERE EXISTS(SELECT 1 FROM videos WHERE id=? AND status!='deleting')`).bind(...keys.map(k => encode((queued as any)[k])), id).run();
                if (!changed.meta.changes) throw new APIError(409, '视频正在删除');
            }
            catch {
                throw new APIError(409, '已有排队或运行中的分析任务');
            }
            return json({ id: draftId, status: 'queued', job_id: queued.id, provider }, 202);
        }
        const row = { id: crypto.randomUUID(), video_id: id, job_id: job.id, provider, model: 'evidence-rules-v1', synthetic: !!job.result.synthetic, text: rulesDraft(facts, language), facts, created_at: now() };
        await insert(env, 'review_drafts', row).run();
        return json(row, 201);
    }
    if ((m = /^\/api\/videos\/([^/]+)\/review-drafts$/.exec(path)) && method === 'GET') {
        await requireRow(env, 'videos', m[1]);
        return json(await rows(env, 'SELECT * FROM review_drafts WHERE video_id=? ORDER BY created_at DESC', [m[1]]));
    }
    if ((m = /^\/api\/videos\/([^/]+)\/review$/.exec(path)) && method === 'PUT') {
        const id = m[1];
        await requireRow(env, 'videos', id);
        const p = await body(req, ['draft_id', 'observations', 'next_action', 'confirmed']), data = { draft_id: p.draft_id == null ? null : text(p.draft_id, 36, 1), observations: text(p.observations, 15000), next_action: text(p.next_action, 5000, 0, ''), confirmed: boolean(p.confirmed) };
        if (data.draft_id && (await requireRow(env, 'review_drafts', data.draft_id)).video_id !== id)
            throw new APIError(422, '草稿不属于此视频');
        if (data.confirmed && !data.observations)
            throw new APIError(422, '确认复盘需要填写观察');
        const record = { id: crypto.randomUUID(), video_id: id, ...data, confirmed_by: data.confirmed ? user.username : null, updated_at: now() };
        return json(await saveHistory(env, 'reviews', 'review_history', 'video_id', id, record));
    }
    if ((m = /^\/api\/videos\/([^/]+)\/score$/.exec(path)) && method === 'GET')
        return json(await history(env, m[1], 'videos', 'manual_scores', 'score_history', 'video_id'));
    if ((m = /^\/api\/videos\/([^/]+)\/score$/.exec(path)) && method === 'PUT') {
        const id = m[1];
        await requireRow(env, 'videos', id);
        const p = await body(req, ['score', 'comment', 'confirmed']), data = { score: number(p.score, 0, 10), comment: text(p.comment, 5000, 0, ''), confirmed: boolean(p.confirmed) };
        if (data.confirmed && !data.comment)
            throw new APIError(422, '确认人工评分需要填写评语');
        return json(await saveHistory(env, 'manual_scores', 'score_history', 'video_id', id, { id: crypto.randomUUID(), video_id: id, ...data, assessor: user.username, rubric_version: 'training-review-10-v1', updated_at: now() }));
    }
    if ((m = /^\/api\/videos\/([^/]+)\/report$/.exec(path)) && method === 'GET') {
        const id = m[1], video = await getVideo(env, id), scores = await history(env, id, 'videos', 'manual_scores', 'score_history', 'video_id');
        return json({ schema_version: 1, exported_at: now(), video, jobs: await assessed(env, await rows(env, 'SELECT * FROM jobs WHERE video_id=? ORDER BY created_at DESC', [id])), drafts: await rows(env, 'SELECT * FROM review_drafts WHERE video_id=? ORDER BY created_at DESC', [id]), review: video.review, events: await rows(env, 'SELECT * FROM events WHERE video_id=? ORDER BY start_sec', [id]), score: scores.current, score_history: scores.history, assessment_history: await rows(env, 'SELECT h.* FROM analysis_assessment_history h JOIN jobs j ON j.id=h.job_id WHERE j.video_id=? ORDER BY h.created_at,h.id', [id]), review_history: await rows(env, 'SELECT * FROM review_history WHERE video_id=? ORDER BY created_at', [id]) });
    }
    if (['/api/insights', '/api/insights/analyses.csv', '/api/insights/export'].includes(path) && method === 'GET') {
        const { filter, today } = await filters(env, url), snapshot = await summarySnapshot(env, filter);
        if (path.endsWith('analyses.csv'))
            return new Response(new Uint8Array(exportCsv(snapshot)).buffer, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="arena-analyses-${filter.start}-${filter.end}.csv"` } });
        if (path.endsWith('export'))
            return new Response(new Uint8Array(exportZip(snapshot, filter, today, env.ARENA_TIMEZONE || 'Asia/Shanghai')).buffer, { headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="arena-insights-${filter.start}-${filter.end}.zip"` } });
        return json({ ...planningSummary(snapshot, filter, today), analysis: analyticsSummary(snapshot) });
    }
    if ((m = /^\/api\/athletes\/([^/]+)\/profile$/.exec(path)) && method === 'GET') {
        const athlete = await requireRow(env, 'athletes', m[1]), snapshot = await summarySnapshot(env, { start: '0001-01-01', end: '9999-12-31', athlete_id: m[1] }), sessions = snapshot.sessions;
        const trends = snapshot.measurements.map((e: any) => ({ date: e.date, category: e.category, job_id: e.job_id, method_version: e.result.method_version, sample_fps: e.result.sample_fps, roi: e.result.roi, metrics: e.result.metrics, model_sha256: e.result.model_sha256 || {} })).sort((a: any, b: any) => a.date.localeCompare(b.date));
        return json({ athlete, sessions, video_count: snapshot.videos.length, recorded_minutes: sessions.reduce((a: any, s: any) => a + s.duration_min, 0), recorded_load: sessions.some((s: any) => s.rpe !== null) ? sessions.filter((s: any) => s.rpe !== null).reduce((a: any, s: any) => a + s.duration_min * s.rpe, 0) : null, load_unit: 'RPE·分钟（自填负荷代理）', trends, analysis: analyticsSummary(snapshot) });
    }
    if (path === '/api/dashboard' && method === 'GET') {
        const filter = { start: '0001-01-01', end: '9999-12-31', athlete_id: null }, snapshot = await summarySnapshot(env, filter), athletes = await rows(env, 'SELECT id FROM athletes');
        return json({ athlete_count: athletes.length, session_count: snapshot.sessions.length, video_count: snapshot.videos.length, pending_review_count: snapshot.videos.length - snapshot.reviewed.length, recorded_minutes: snapshot.sessions.reduce((a: any, s: any) => a + s.duration_min, 0), category_counts: Object.fromEntries(videoCategories.map(c => [c, snapshot.videos.filter((v: any) => v.category === c).length])), recent_jobs: await assessed(env, await rows(env, 'SELECT * FROM jobs ORDER BY created_at DESC LIMIT 8')), review_scores: planningSummary(snapshot, filter, workspaceToday(env.ARENA_TIMEZONE || 'Asia/Shanghai')).manual_scores, analysis: analyticsSummary(snapshot) });
    }
    throw new APIError(404, '接口不存在');
}
function secure(response: Response, req: Request) { const h = new Headers(response.headers); h.set('X-Content-Type-Options', 'nosniff'); h.set('Referrer-Policy', 'same-origin'); h.set('X-Frame-Options', 'DENY'); h.set('Cache-Control', 'no-store'); h.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' https: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"); if (new URL(req.url).protocol === 'https:')
    h.set('Strict-Transport-Security', 'max-age=31536000'); return new Response(response.body, { status: response.status, headers: h }); }
export default { async fetch(req: Request, env: Env, _ctx: any) { try {
        if (!env.MEDIA) env = { ...env, MEDIA: new D1ResultStore(env.DB), ARENA_RESULTS_ONLY: 'true' };
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
            const origin = req.headers.get('origin'), allowed = env.ARENA_PUBLIC_URL || new URL(req.url).origin;
            if (origin && origin !== allowed)
                throw new APIError(403, '来源不允许');
        }
        const response = await api(req, env);
        if (!response)
            throw new APIError(404, '接口不存在');
        return secure(response, req);
    }
    catch (error: any) {
        const status = error instanceof APIError ? error.status : error?.status === 422 ? 422 : 500;
        if (status === 500)
            console.error('API failure', error?.message);
        return secure(json({ detail: status === 500 ? '服务器暂时无法处理请求' : error.message }, status), req);
    } } };
