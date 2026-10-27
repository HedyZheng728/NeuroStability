/** Observed measurements and pseudonymous exports; mirrors arena.analytics/planning. */
export type Row = Record<string, any>;
export type Filters = {
    start: string;
    end: string;
    athlete_id: string | null;
};
export type Snapshot = Record<string, Row[]>;
type Database = {
    prepare(sql: string): {
        bind(...args: any[]): any;
    };
    batch(statements: any[]): Promise<{
        results?: Row[];
    }[]>;
};
export const CATEGORIES = ['stability', 'footwork', 'attack', 'defense', 'mixed'];
const METRICS = ['hip_sway_ratio', 'trunk_lean_deg', 'ankle_span_ratio'];
const STATUSES = ['completed', 'needs_review', 'queued', 'running', 'failed', 'blocked', 'not_analyzed'];
const FRAME_FIELDS = ['total_frames', 'usable_frames', 'ambiguous_frames', 'missing_frames'];
const POSE_BACKENDS = ['rtmpose', 'rtmpose_tracking'];
export const finite = (v: any): v is number => typeof v === 'number' && Number.isFinite(v);
const count = (v: any): v is number => finite(v) && Number.isInteger(v) && v >= 0;
const mapping = (v: any): Row => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const pick = (row: Row, keys: string[]) => Object.fromEntries(keys.map(k => [k, row[k] ?? null]));
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const compare = (a: any[], b: any[]) => {
    for (let i = 0; i < a.length; i++) {
        if (a[i] < b[i])
            return -1;
        if (a[i] > b[i])
            return 1;
    }
    return 0;
};
const sorted = (rows: Row[], keys: string[]) => [...rows].sort((a, b) => compare(keys.map(k => a[k]), keys.map(k => b[k])));
const by = (rows: Row[], key: string) => new Map(rows.map(r => [r[key], r]));
const zeros = (keys: string[]): Row => Object.fromEntries(keys.map(k => [k, 0]));
export function workspaceToday(timezone = 'Asia/Shanghai'): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(new Date());
    const value = (part: string) => parts.find(p => p.type === part)!.value;
    return `${value('year')}-${value('month')}-${value('day')}`;
}
export function dateFilters(start?: string | null, end?: string | null, athleteId: string | null = null, today = workspaceToday()): Filters {
    end = end || today;
    for (const day of [start, end].filter((value): value is string => Boolean(value))) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day.startsWith('0000-') || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day)
            throw Object.assign(new Error('日期格式无效'), { status: 422 });
    }
    start = start || new Date(Date.parse(`${end}T00:00:00Z`) - 55 * 86400000).toISOString().slice(0, 10);
    if (start > end)
        throw Object.assign(new Error('开始日期不能晚于结束日期'), { status: 422 });
    return {
        start,
        end,
        athlete_id: athleteId
    };
}
export function eligibleResult(result: any): boolean {
    return mapping(result).synthetic === false && Object.values(mapping(result.metrics)).some(metric => finite(mapping(metric).value));
}
export async function readSnapshot(db: Database, filters: Filters): Promise<Snapshot> {
    const bindings = [filters.start, filters.end, ...(filters.athlete_id === null ? [] : [filters.athlete_id])];
    const condition = `s.date >= ? AND s.date <= ?${filters.athlete_id === null ? '' : ' AND s.athlete_id = ?'}`;
    const planCondition = `p.date >= ? AND p.date <= ?${filters.athlete_id === null ? '' : ' AND p.athlete_id = ?'}`;
    const base = 'FROM videos v JOIN sessions s ON v.session_id = s.id';
    const queries = [
        `SELECT s.* FROM sessions s WHERE ${condition} ORDER BY s.date,s.id`,
        `SELECT p.*,s.date AS session_date FROM training_plans p LEFT JOIN sessions s ON p.session_id=s.id WHERE ${planCondition} ORDER BY p.date,p.id`,
        `SELECT v.id,v.session_id,v.category,v.filename,v.size_bytes,s.date,s.athlete_id ${base} WHERE ${condition} ORDER BY v.id`,
        `SELECT j.id,j.video_id,j.backend,j.status,j.params,j.metadata,j.result,j.created_at ${base} JOIN jobs j ON j.video_id=v.id WHERE ${condition} ORDER BY j.created_at,j.id`,
        `SELECT a.* ${base} JOIN jobs j ON j.video_id=v.id JOIN analysis_assessments a ON a.job_id=j.id WHERE ${condition} ORDER BY a.job_id`,
        `SELECT m.video_id,m.confirmed ${base} JOIN manual_scores m ON m.video_id=v.id WHERE ${condition} ORDER BY m.video_id`,
        `SELECT r.video_id ${base} JOIN reviews r ON r.video_id=v.id WHERE ${condition} AND r.confirmed=1`,
        `SELECT m.id AS score_id,m.video_id,v.session_id,s.athlete_id,s.date,v.category,m.rubric_version,m.score,m.confirmed,m.updated_at ${base} JOIN manual_scores m ON m.video_id=v.id WHERE ${condition} AND m.confirmed=1 ORDER BY s.date,m.video_id`,
        `SELECT e.id,e.video_id,v.session_id,s.athlete_id,s.date,v.category,e.start_sec,e.end_sec,e.label,e.actor,e.outcome ${base} JOIN events e ON e.video_id=v.id WHERE ${condition} ORDER BY s.date,e.video_id,e.start_sec,e.id`,
        `SELECT j.id AS job_id,v.id AS video_id,v.session_id,s.athlete_id,s.date,v.category,j.result,j.params,d.id AS draft_id ${base} JOIN reviews r ON r.video_id=v.id JOIN review_drafts d ON d.id=r.draft_id JOIN jobs j ON j.id=d.job_id WHERE ${condition} AND r.confirmed=1 AND d.synthetic=0 AND d.video_id=v.id AND j.video_id=v.id AND j.backend='rtmpose' AND j.status='completed' ORDER BY s.date,j.id`,
    ];
    // D1 executes a batch as one transaction, preserving selection across concurrent writes.
    const results = await db.batch(queries.map(q => db.prepare(q).bind(...bindings)));
    const names = ['sessions', 'plans', 'videos', 'jobs', 'assessments', 'current_scores', 'reviewed', 'scores', 'events', 'measurements'];
    const data: Snapshot = {};
    results.forEach((result, i) => {
        data[names[i]] = (result.results || []).map(raw => {
            const row = { ...raw };
            for (const key of ['params', 'metadata', 'result'])
                if (typeof row[key] === 'string')
                    row[key] = JSON.parse(row[key]);
            if ('confirmed' in row)
                row.confirmed = Boolean(row.confirmed);
            return row;
        });
    });
    const excluded = new Set(data.assessments.filter(r => ['excluded', 'superseded'].includes(r.decision)).map(r => r.job_id));
    data.measurements = data.measurements.filter(r => eligibleResult(r.result) && !excluded.has(r.job_id));
    return data;
}
export function statistics(values: number[]) {
    const rows = [...values].sort((a, b) => a - b);
    const quantile = (p: number) => {
        const i = (rows.length - 1) * p;
        return rows[Math.floor(i)] + (rows[Math.ceil(i)] - rows[Math.floor(i)]) * (i - Math.floor(i));
    };
    return {
        n: rows.length,
        median: rows.length ? quantile(.5) : null,
        q1: rows.length ? quantile(.25) : null,
        q3: rows.length ? quantile(.75) : null
    };
}
function load(rows: Row[]): number | null {
    const known = rows.filter(r => r.rpe !== null);
    return known.length ? sum(known.map(r => r.duration_min * r.rpe)) : null;
}
export function planningSummary(data: Snapshot, filters: Filters, today = workspaceToday()): Row {
    const sessions = data.sessions, scores = data.scores.map(r => r.score), cutoff = [filters.end, today].sort()[0];
    const scoreCounts = new Map<number, number>();
    for (const score of scores) scoreCounts.set(score, (scoreCounts.get(score) || 0) + 1);
    const due = data.plans.filter(p => p.date <= cutoff && p.status !== 'cancelled');
    const completed = due.filter(p => p.session_id !== null && p.session_date !== null && p.session_date <= cutoff).length;
    const weeks = new Map<string, Row[]>();
    for (const row of sessions) {
        const day = new Date(row.date + 'T00:00:00Z');
        day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
        const key = day.toISOString().slice(0, 10);
        if (!weeks.has(key)) weeks.set(key, []);
        weeks.get(key)!.push(row);
    }
    const categories = [...new Set(data.scores.map(r => r.category))].sort();
    return {
        filters,
        summary: {
            session_count: sessions.length,
            total_minutes: sum(sessions.map(r => r.duration_min)),
            load_au: load(sessions),
            rpe_recorded: sessions.filter(r => r.rpe !== null).length,
            video_count: data.videos.length,
            reviewed_videos: data.reviewed.length,
            verified_measurements: data.measurements.length,
            annotation_count: data.events.length
        },
        planning: {
            due_count: due.length,
            completed_count: completed,
            cancelled_count: data.plans.filter(p => p.status === 'cancelled').length,
            completion_rate: due.length ? completed / due.length : null
        },
        weekly: [...weeks.keys()].sort().map(key => {
            const rows = weeks.get(key)!;
            return {
                week_start: key,
                session_count: rows.length,
                minutes: sum(rows.map(r => r.duration_min)),
                load_au: load(rows),
                rpe_recorded: rows.filter(r => r.rpe !== null).length
            };
        }),
        statistics: { duration_min: statistics(sessions.map(r => r.duration_min)), rpe: statistics(sessions.filter(r => r.rpe !== null).map(r => r.rpe)) },
        manual_scores: {
            ...statistics(scores),
            mean: scores.length ? sum(scores) / scores.length : null,
            distribution: [...scoreCounts.keys()].sort((a, b) => a - b).map(score => ({ score, n: scoreCounts.get(score) })),
            by_category: Object.fromEntries(categories.map(category => {
                const values = data.scores.filter(r => r.category === category).map(r => r.score);
                return [category, { n: values.length, mean: sum(values) / values.length }];
            }))
        },
        category_counts: Object.fromEntries(CATEGORIES.map(category => [category, data.videos.filter(r => r.category === category).length]))
    };
}
export function analyzedResult(job: Row): Row {
    const result = mapping(job.result);
    return ['completed', 'needs_review'].includes(job.status) && result.synthetic === false ? result : {};
}
function selectJobs(data: Snapshot, terminalOnly = false): [
    Map<string, Row>,
    Map<string, number>
] {
    const videos = new Set(data.videos.map(r => r.id)), latest = new Map<string, Row>(), durations = new Map<string, number>();
    for (const job of sorted(data.jobs || [], ['created_at', 'id'])) {
        if (!videos.has(job.video_id) || job.backend === 'sample' || mapping(job.result).synthetic === true)
            continue;
        const duration = mapping(job.metadata).source_duration;
        if (finite(duration) && duration > 0)
            durations.set(job.video_id, duration);
        if (POSE_BACKENDS.includes(job.backend) && (!terminalOnly || Object.keys(analyzedResult(job)).length))
            latest.set(job.video_id, job);
    }
    return [latest, durations];
}
export function quality(result: Row): [
    Row | null,
    boolean
] {
    const stored = mapping(result.quality), values = FRAME_FIELDS.map(f => stored[f]);
    if (!values.every(count) || values[0] !== sum(values.slice(1)))
        return [null, false];
    const [total, usable, ambiguous] = values, ratio = total ? usable / total : null, minimum = 'minimum_usable_frames' in stored ? stored.minimum_usable_frames : 10, coverage = 'minimum_coverage' in stored ? stored.minimum_coverage : .6;
    const passed = count(minimum) && finite(coverage) && coverage >= 0 && coverage <= 1 && ratio !== null && usable >= minimum && ratio >= coverage && ambiguous === 0 && result.needs_review !== true;
    return [{ ...Object.fromEntries(FRAME_FIELDS.map((f, i) => [f, values[i]])), usable_ratio: ratio }, passed];
}
export function metricValues(result: Row): Row {
    const metrics = mapping(result.metrics);
    return Object.fromEntries(METRICS.filter(name => finite(mapping(metrics[name]).value)).map(name => [name, Object.fromEntries(Object.entries(metrics[name]).filter(([key]) => ['value', 'unit', 'label', 'formula'].includes(key)))]));
}
export function acceptanceError(job: Row, subjectRole: string): string | null {
    if (subjectRole !== 'athlete')
        return '接受分析须明确确认目标为运动员';
    const result = mapping(job.result);
    if (POSE_BACKENDS.includes(job.backend)) {
        const [c] = quality(result);
        if (!Object.keys(metricValues(result)).length || !c || c.usable_frames < 10 || c.usable_ratio === null || c.usable_ratio < .6 || c.ambiguous_frames !== 0)
            return '姿态分析须有有限实测指标、至少10个可用帧、覆盖率至少60%，且无歧义帧';
    }
    else if (job.backend === 'sam2') {
        const s = mapping(result.segmentation), total = s.total_frames, segmented = s.segmented_frames, objects = s.object_count, prompted = s.prompted_objects;
        if (result.kind !== 'segmentation' || ![total, segmented, objects].every(count) || !(segmented > 0 && segmented <= total) || objects <= 0 || (prompted != null && (!count(prompted) || objects > prompted)))
            return '人物分割须有非零且一致的分割帧数和目标数';
    }
    return null;
}
function provenance(job: Row, result: Row): Row {
    const params = mapping(job.params);
    const target = 'selected_track_id' in result ? result.selected_track_id : 'target_track_id' in result ? result.target_track_id : params.target_track_id;
    const source = 'source_pose_job_id' in result ? result.source_pose_job_id : params.source_pose_job_id;
    return { target_track_id: count(target) && target >= 1 && target <= 100000 ? target : null, source_pose_job_id: typeof source === 'string' && source.length > 0 && source.length <= 36 ? source : null };
}
export function analyticsSummary(data: Snapshot): Row {
    const [latest, durations] = selectJobs(data), [reviewLatest] = selectJobs(data, true), assessments = by(data.assessments || [], 'job_id'), reviewCounts = zeros(['reviewed', 'pending', 'accepted', 'excluded', 'superseded']), statusCounts = zeros(STATUSES), frames = zeros(['total', 'usable', 'ambiguous', 'missing']);
    const bySession = by(data.sessions.map(r => ({
        session_id: r.id,
        date: r.date,
        athlete_id: r.athlete_id,
        duration_min: r.duration_min,
        video_count: 0,
        analyzed_videos: 0,
        review_needed: 0
    })), 'session_id');
    const confirmed = new Set(data.measurements.map(r => r.job_id)), scores = new Map((data.current_scores || []).map(r => [r.video_id, r.confirmed])), scoreCounts = zeros(['confirmed', 'draft', 'unscored']);
    const measurements: Row[] = [], reviewQueue: Row[] = [];
    let analyzed = 0, known = 0, passed = 0;
    for (const video of data.videos) {
        const session = bySession.get(video.session_id)!;
        session.video_count++;
        scoreCounts[scores.get(video.id) === true ? 'confirmed' : scores.has(video.id) ? 'draft' : 'unscored']++;
        const reviewJob = reviewLatest.get(video.id);
        if (reviewJob) {
            const decision = assessments.get(reviewJob.id)?.decision ?? 'pending';
            if (['accepted', 'excluded', 'superseded'].includes(decision)) {
                reviewCounts.reviewed++;
                reviewCounts[decision]++;
            }
            else {
                reviewCounts.pending++;
                session.review_needed++;
                const [c] = quality(analyzedResult(reviewJob));
                reviewQueue.push({
                    video_id: video.id,
                    job_id: reviewJob.id,
                    filename: video.filename,
                    date: video.date,
                    usable_ratio: c?.usable_ratio ?? null,
                    total_frames: c?.total_frames ?? null,
                    ambiguous_frames: c?.ambiguous_frames ?? null
                });
            }
        }
        const job = latest.get(video.id), status = job?.status ?? 'not_analyzed';
        statusCounts[status in statusCounts ? status : 'not_analyzed']++;
        if (!job)
            continue;
        const result = analyzedResult(job);
        if (!Object.keys(result).length)
            continue;
        analyzed++;
        session.analyzed_videos++;
        const [c, qualityPassed] = quality(result);
        if (c) {
            known++;
            passed += Number(qualityPassed);
            Object.keys(frames).forEach((key, i) => {
                frames[key] += c[FRAME_FIELDS[i]];
            });
        }
        const metrics = metricValues(result), decision = assessments.get(job.id)?.decision ?? null;
        if (Object.keys(metrics).length && !['excluded', 'superseded'].includes(decision))
            measurements.push({
                video_id: video.id,
                job_id: job.id,
                filename: video.filename,
                date: video.date,
                category: video.category,
                method_version: result.method_version ?? null,
                quality_passed: qualityPassed,
                confirmed: confirmed.has(job.id),
                metrics,
                assessment_decision: decision,
                ...provenance(job, result)
            });
    }
    frames.usable_ratio = frames.total ? frames.usable / frames.total : null;
    const times = [...durations.values()], bins = ['0-10', '10-30', '30-60', '60+'].map(key => ({ key, count: 0 }));
    times.forEach(seconds => bins[seconds <= 10 ? 0 : seconds <= 30 ? 1 : seconds <= 60 ? 2 : 3].count++);
    measurements.sort((a, b) => compare([!a.quality_passed, a.date, a.video_id, a.job_id], [!b.quality_passed, b.date, b.video_id, b.job_id]));
    const videoIds = new Set(data.videos.map(v => v.id)), orderedJobs = sorted(data.jobs || [], ['created_at', 'id']);
    const capabilities = [['rtmpose_tracking', 'pose', 'tracking', 'track_count'], ['sam2', 'segmentation', 'segmentation', 'segmented_frames'], ['action', 'recognition', '', ''], ['pose3d', 'pose3d', 'pose3d', 'frame_count']].map(([backend, kind, key, field]) => {
        const produced = new Map<string, string>();
        for (const job of orderedJobs) {
            if (job.backend !== backend || !videoIds.has(job.video_id))
                continue;
            const result = analyzedResult(job);
            if (result.kind !== kind)
                continue;
            const value = mapping(result[key])[field], available = backend === 'action' ? Array.isArray(result.windows) && result.windows.length > 0 : count(value) && value > 0;
            if (available)
                produced.set(job.video_id, job.id);
        }
        const first = [...produced.keys()].sort()[0] ?? null;
        return {
            backend,
            processed_videos: produced.size,
            video_count: videoIds.size,
            first_video_id: first,
            first_job_id: first ? produced.get(first) : null
        };
    });
    return {
        video_count: data.videos.length,
        analyzed_videos: analyzed,
        status_counts: statusCounts,
        storage_bytes: sum(data.videos.map(v => v.size_bytes)),
        footage_seconds: times.length ? sum(times) : null,
        duration_known: times.length,
        duration_stats: {
            ...statistics(times),
            mean: times.length ? sum(times) / times.length : null,
            min: times.length ? times.reduce((minimum, value) => Math.min(minimum, value), Infinity) : null,
            max: times.length ? times.reduce((maximum, value) => Math.max(maximum, value), -Infinity) : null
        },
        duration_bins: bins,
        frames,
        quality_known: known,
        quality_passed: passed,
        needs_review: reviewCounts.pending,
        review_counts: reviewCounts,
        scores: scoreCounts,
        by_session: sorted([...bySession.values()], ['date', 'session_id']),
        measurement_count: measurements.length,
        measurements: measurements.slice(0, 12),
        review_queue: sorted(reviewQueue, ['date', 'video_id', 'job_id']).slice(0, 6),
        capabilities
    };
}
export const CSV_COLUMNS = ['athlete_id', 'session_id', 'date', 'video_id', 'category', 'job_id', 'backend', 'status', 'created_at', 'experimental', 'confirmed', 'assessment_decision', 'target_track_id', 'source_pose_job_id', 'method_version', 'sample_fps', 'roi_json', 'start_sec', 'end_sec', 'source_duration', 'quality_known', 'quality_passed', ...FRAME_FIELDS, 'usable_ratio', 'confidence_threshold', 'minimum_usable_frames', 'minimum_coverage', 'model_sha256_json', ...METRICS];
export function csvValue(value: any): any {
    if (value == null)
        return '';
    if (typeof value === 'string' && (/^[\t\r\n]/.test(value) || /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*[=+@-]/.test(value)))
        return "'" + value;
    return value;
}
function csv(columns: string[], rows: Row[]): string {
    const cell = (v: any) => {
        v = csvValue(v);
        const s = typeof v === 'boolean' ? (v ? 'True' : 'False') : String(v);
        return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return [columns.join(','), ...rows.map(row => columns.map(k => cell(row[k])).join(','))].join('\r\n') + '\r\n';
}
// Python json.dumps spacing is retained for JSON-valued CSV cells.
function pythonJson(value: any, sortKeys = false, ascii = false): string {
    if (value === undefined || value === null)
        return 'null';
    if (typeof value === 'string') {
        const s = JSON.stringify(value);
        return ascii ? s.replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) : s;
    }
    if (Array.isArray(value))
        return '[' + value.map(v => pythonJson(v, sortKeys, ascii)).join(', ') + ']';
    if (typeof value === 'object') {
        const keys = Object.keys(value);
        if (sortKeys)
            keys.sort();
        return '{' + keys.map(k => pythonJson(k, false, ascii) + ': ' + pythonJson(value[k], sortKeys, ascii)).join(', ') + '}';
    }
    return JSON.stringify(value);
}
export function exportCsv(data: Snapshot): Uint8Array {
    const [latest, durations] = selectJobs(data), confirmed = new Set(data.measurements.map(r => r.job_id)), assessments = by(data.assessments || [], 'job_id'), rows: Row[] = [];
    for (const video of sorted(data.videos, ['date', 'id'])) {
        const job = latest.get(video.id);
        if (!job)
            continue;
        const result = analyzedResult(job), params = mapping(job.params), [c, passed] = quality(result), stored = mapping(result.quality), metrics = metricValues(result);
        const row: Row = {
            ...pick(video, ['athlete_id', 'session_id', 'date', 'category']),
            video_id: video.id,
            job_id: job.id,
            ...pick(job, ['backend', 'status', 'created_at']),
            experimental: true,
            confirmed: confirmed.has(job.id),
            method_version: result.method_version ?? null,
            assessment_decision: assessments.get(job.id)?.decision ?? null,
            ...provenance(job, result),
            source_duration: durations.get(video.id),
            quality_known: c !== null,
            quality_passed: c !== null ? passed : null,
            ...(c || {}),
            ...Object.fromEntries(METRICS.map(name => [name, metrics[name]?.value ?? null]))
        };
        for (const [source, fields] of [[result, ['sample_fps']], [params, ['start_sec', 'end_sec']], [stored, ['confidence_threshold', 'minimum_usable_frames', 'minimum_coverage']]] as [
            Row,
            string[]
        ][])
            for (const field of fields) {
                const v = source[field];
                row[field] = finite(v) && v >= 0 ? v : null;
            }
        const roi = 'roi' in result ? result.roi : params.roi;
        if (Array.isArray(roi) && roi.length === 4 && roi.every(finite))
            row.roi_json = pythonJson(roi);
        const hashes = Object.fromEntries(Object.entries(mapping(result.model_sha256)).filter(([key, v]) => ['detector', 'pose'].includes(key) && typeof v === 'string' && /^[0-9a-fA-F]{64}$/.test(v)));
        if (Object.keys(hashes).length)
            row.model_sha256_json = pythonJson(hashes, true);
        rows.push(row);
    }
    return new TextEncoder().encode(csv(CSV_COLUMNS, rows));
}
export const COLUMNS: Record<string, any> = {
    "sessions": {
        "session_id": "Recorded session UUID",
        "athlete_id": "Athlete UUID; pseudonymous, linkable identifier",
        "date": "Training date, YYYY-MM-DD",
        "duration_min": "Self-recorded duration, minutes",
        "rpe": "Self-recorded perceived exertion, 0..10; blank if missing",
        "load_au": "duration_min * rpe, arbitrary units; blank when RPE is missing"
    },
    "plans": {
        "plan_id": "Training plan UUID",
        "athlete_id": "Athlete UUID",
        "date": "Planned date, YYYY-MM-DD",
        "category": "stability | footwork | attack | defense",
        "planned_minutes": "Planned duration, minutes",
        "status": "planned | cancelled | completed; completed requires a linked recorded session",
        "session_id": "Linked recorded session UUID, blank if unlinked",
        "session_date": "Linked session training date"
    },
    "metrics": {
        "athlete_id": "Athlete UUID",
        "session_id": "Recorded session UUID",
        "date": "Session training date",
        "video_id": "Source video UUID; source media excluded",
        "category": "Video training category",
        "job_id": "Confirmed completed real RTMPose analysis UUID",
        "draft_id": "Confirmed review draft UUID",
        "method_version": "Version of measurement method",
        "sample_fps": "Analysis sampling rate, frames/second",
        "roi_json": "Normalized region of interest [x,y,width,height], or null",
        "start_sec": "Analysis clip start on original video timeline, seconds",
        "end_sec": "Analysis clip end on original video timeline, seconds; blank when not specified",
        "metric": "Measurement identifier",
        "value": "Observed numeric value; blank if missing",
        "unit": "Measurement unit from analysis",
        "formula": "Measurement formula from method",
        "quality_json": "Analysis quality counters, confidence threshold and eligibility thresholds",
        "model_sha256_json": "Model artifact SHA-256 provenance"
    },
    "events": {
        "event_id": "Manual annotation UUID",
        "video_id": "Source video UUID",
        "session_id": "Recorded session UUID",
        "athlete_id": "Athlete UUID",
        "date": "Session training date",
        "category": "Video training category",
        "start_sec": "Start on original video timeline, seconds",
        "end_sec": "End on original video timeline, seconds",
        "label": "User-recorded event label",
        "actor": "athlete | opponent | unknown",
        "outcome": "User-recorded outcome; no automated classification implied"
    },
    "scores": {
        "score_id": "Current training review score UUID",
        "video_id": "Source video UUID",
        "session_id": "Recorded session UUID",
        "athlete_id": "Athlete UUID",
        "date": "Session training date",
        "category": "Video training category",
        "rubric_version": "Stored scoring method version; historical versions retained",
        "score": "Subjective training video review score, 0..10 points; not a validated ability measure or competition score",
        "confirmed": "Review approved current score; only approved scores with a comment are exported",
        "updated_at": "Current score save timestamp, ISO 8601 UTC"
    }
};
export const MANIFEST_TEXT: Record<string, any> = {
    "schema_version": 2,
    "selection": "Sessions, videos, metrics, events and scores use session training date; plans use planned date. Bounds are inclusive.",
    "missing_values": "CSV blank fields represent missing values, never zero. JSON null represents missing values.",
    "measurement_eligibility": "Confirmed review linked to a non-synthetic draft and completed RTMPose job, real result, at least one finite numeric metric. All metrics of that eligible result are retained, including nulls.",
    "formulas": {
        "load_au": "sum(duration_min * rpe) over sessions with recorded RPE; null when none are recorded",
        "rpe_recorded": "count of sessions with non-null RPE, including zero",
        "completion_rate": "completed_count / due_count; null when due_count is zero",
        "due_count": "non-cancelled plans in the requested date range due on/before min(end,as_of_date), using workspace timezone",
        "completed_count": "due plans linked to an actual session dated on/before completion_cutoff_date",
        "quantiles": "Type 7: h=(n-1)*p, interpolate sorted observations at floor(h) and ceil(h); n=0 null, n=1 observation",
        "weeks": "Monday start; observed sessions only, no fabricated empty weeks",
        "hip_sway_ratio": "population standard deviation of hip midpoint x / median torso length",
        "trunk_lean_deg": "mean atan2(abs(shoulder midpoint x - hip midpoint x), hip midpoint y - shoulder midpoint y), degrees",
        "ankle_span_ratio": "mean two-dimensional ankle distance / median torso length"
    },
    "privacy": "Athlete names, objectives, notes, reviewer identities, score comments, assessors, media, storage paths and authentication data excluded. UUIDs remain linkable; this is pseudonymous data.",
    "csv_safety": "Apostrophe prefix escapes formula-like strings. Numeric values remain numeric."
};
/** STORE-format ZIP uses Web APIs only; content and CRCs are interoperable with zipfile/unzip. */
function zipFiles(files: Record<string, string>): Uint8Array {
    const encoder = new TextEncoder(), locals: Uint8Array[] = [], central: Uint8Array[] = [];
    let offset = 0;
    const crc32 = (bytes: Uint8Array) => {
        let crc = 0xffffffff;
        for (const b of bytes) {
            crc ^= b;
            for (let i = 0; i < 8; i++)
                crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
        }
        return (crc ^ 0xffffffff) >>> 0;
    };
    for (const [name, text] of Object.entries(files)) {
        const filename = encoder.encode(name), body = encoder.encode(text), crc = crc32(body), local = new Uint8Array(30 + filename.length + body.length), lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034b50, true);
        lv.setUint16(4, 20, true);
        lv.setUint16(6, 0x0800, true);
        lv.setUint16(12, 0x21, true);
        lv.setUint32(14, crc, true);
        lv.setUint32(18, body.length, true);
        lv.setUint32(22, body.length, true);
        lv.setUint16(26, filename.length, true);
        local.set(filename, 30);
        local.set(body, 30 + filename.length);
        const entry = new Uint8Array(46 + filename.length), ev = new DataView(entry.buffer);
        ev.setUint32(0, 0x02014b50, true);
        ev.setUint16(4, 20, true);
        ev.setUint16(6, 20, true);
        ev.setUint16(8, 0x0800, true);
        ev.setUint16(14, 0x21, true);
        ev.setUint32(16, crc, true);
        ev.setUint32(20, body.length, true);
        ev.setUint32(24, body.length, true);
        ev.setUint16(28, filename.length, true);
        ev.setUint32(42, offset, true);
        entry.set(filename, 46);
        locals.push(local);
        central.push(entry);
        offset += local.length;
    }
    const centralSize = sum(central.map(c => c.length)), end = new Uint8Array(22), view = new DataView(end.buffer);
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(8, central.length, true);
    view.setUint16(10, central.length, true);
    view.setUint32(12, centralSize, true);
    view.setUint32(16, offset, true);
    const output = new Uint8Array(offset + centralSize + end.length);
    let at = 0;
    for (const bytes of [...locals, ...central, end]) {
        output.set(bytes, at);
        at += bytes.length;
    }
    return output;
}
export function exportZip(data: Snapshot, filters: Filters, today?: string, timezone = 'Asia/Shanghai'): Uint8Array {
    today = today ?? workspaceToday(timezone);
    const exported: Record<string, Row[]> = Object.fromEntries(Object.keys(COLUMNS).map(key => [key, []]));
    for (const row of data.sessions)
        exported.sessions.push({
            session_id: row.id,
            ...pick(row, ['athlete_id', 'date', 'duration_min', 'rpe']),
            load_au: row.rpe !== null ? row.duration_min * row.rpe : null
        });
    for (const row of data.plans)
        exported.plans.push({
            plan_id: row.id,
            ...pick(row, ['athlete_id', 'date', 'category', 'planned_minutes', 'session_id', 'session_date']),
            status: row.session_id !== null ? 'completed' : row.status
        });
    for (const row of data.events)
        exported.events.push({ event_id: row.id, ...pick(row, Object.keys(COLUMNS.events).filter(k => k !== 'event_id')) });
    exported.scores = data.scores.map(row => pick(row, Object.keys(COLUMNS.scores)));
    for (const row of data.measurements) {
        const result = row.result;
        for (const [name, raw] of Object.entries(result.metrics)) {
            const metric = mapping(raw);
            exported.metrics.push({
                ...pick(row, ['athlete_id', 'session_id', 'date', 'video_id', 'category', 'job_id', 'draft_id']),
                method_version: result.method_version ?? null,
                sample_fps: result.sample_fps ?? null,
                roi_json: pythonJson(result.roi, false, true),
                start_sec: 'start_sec' in row.params ? row.params.start_sec : 0,
                end_sec: row.params.end_sec ?? null,
                metric: name,
                value: metric.value ?? null,
                unit: metric.unit ?? null,
                formula: metric.formula ?? null,
                quality_json: pythonJson('quality' in result ? result.quality : {}, true),
                model_sha256_json: pythonJson('model_sha256' in result ? result.model_sha256 : {}, true, true)
            });
        }
    }
    const manifest = {
        ...MANIFEST_TEXT,
        schema_version: 2,
        exported_at: new Date().toISOString().replace(/Z$/, '+00:00'),
        filters,
        timezone,
        as_of_date: today,
        completion_cutoff_date: [filters.end, today].sort()[0],
        counts: Object.fromEntries(Object.entries(exported).map(([name, rows]) => [name, rows.length])),
        summary: planningSummary(data, filters, today),
        manual_scoring: {
            rubric_version: 'training-review-10-v1',
            source: 'training video review',
            range: [0, 10],
            unit: 'points',
            eligibility: 'Current approved scores only; comment required. Scores are subjective training clip reviews, not a validated ability measure or competition score.',
            statistics: 'Each eligible video contributes its current score once; arithmetic mean and Type 7 quantiles.'
        }
    };
    const dictionary = {
        columns: Object.fromEntries(Object.entries(COLUMNS).map(([name, columns]) => [name + '.csv', columns])),
        encoding: 'UTF-8',
        delimiter: ',',
        date_format: 'YYYY-MM-DD',
        measurement_units: 'Each metric carries its stored unit; ratios use image-plane torso length, not physical distance.',
        limits: 'Self-recorded load and experimental image-plane metrics do not establish ability, health or causal improvement.'
    };
    const files = Object.fromEntries(Object.entries(exported).map(([name, rows]) => [name + '.csv', csv(Object.keys(COLUMNS[name]), rows)]));
    files['manifest.json'] = JSON.stringify(manifest, null, 2);
    files['data_dictionary.json'] = JSON.stringify(dictionary, null, 2);
    return zipFiles(files);
}
export function compactKinematics(kinematics: Row): Row {
    const compact = Object.fromEntries(Object.entries(kinematics).filter(([key]) => ['method_version', 'summary', 'metrics', 'quality', 'limitations', 'status', 'unit', 'units', 'experimental'].includes(key)));
    if ('tracks' in kinematics)
        compact.tracks = kinematics.tracks.map((track: Row) => Object.fromEntries(Object.entries(track).filter(([key]) => key !== 'series')));
    return compact;
}
export function factsFor(job: Row): Row {
    const result = job.result, kind = result.kind;
    if (kind === 'pose3d') {
        const raw = result.pose3d || {}, summary: Row = Object.fromEntries(Object.entries(raw).filter(([key, v]) => ['frame_count', 'person_observation_count', 'segment_count'].includes(key) && count(v)));
        summary.track_count = (raw.track_ids || []).length;
        return {
            job_id: job.id,
            synthetic: false,
            kind,
            method_version: result.method_version,
            summary,
            limitations: result.limitations || []
        };
    }
    if (kind === 'segmentation') {
        const raw = 'segmentation' in result ? result.segmentation : result.summary;
        let summary: Row = Object.fromEntries(Object.entries(mapping(raw)).filter(([key, v]) => ['segmented_frames', 'total_frames', 'object_count', 'prompted_objects'].includes(key) && count(v)));
        if ((summary.segmented_frames ?? 0) > (summary.total_frames ?? 0))
            summary = {};
        const facts: Row = {
            job_id: job.id,
            synthetic: false,
            kind,
            method_version: result.method_version,
            summary,
            limitations: result.limitations ?? ['人物遮罩只表示图像区域，不等于身份、技术、动作结果或裁判得分。']
        };
        if (result.kinematics)
            facts.kinematics = compactKinematics(result.kinematics);
        return facts;
    }
    if (kind === 'recognition') {
        const windows = result.windows || [];
        return {
            job_id: job.id,
            synthetic: false,
            kind,
            method_version: result.method_version,
            candidate_label: result.candidate_label,
            limitations: result.limitations,
            summary: { window_count: windows.length, sampled_frame_count: sum(windows.map((window: Row) => (window.source_frame_times_sec || []).length)) },
            notice: '模型动作候选，尚未确认；不含执行者、成功或裁判得分判断'
        };
    }
    const facts = { job_id: job.id, ...pick(result, ['synthetic', 'method_version', 'quality', 'metrics', 'limitations', 'specialty_score']) };
    if (result.kinematics)
        (facts as Row).kinematics = compactKinematics(result.kinematics);
    return facts;
}
const LIMITATIONS_EN: Record<string, string> = {
    "实验性二维代理指标，受机位、透视、镜头移动、遮挡与动作类型影响。": "Experimental 2D proxies depend on camera position, perspective, camera motion, occlusion and movement type.",
    "髋中点不是人体真实重心；图像坐标不能推断力量、真实速度或竞技能力。": "The hip midpoint is not the body's center of mass; image coordinates cannot establish force, real speed or athletic ability.",
    "人物编号仅帧内有效；固定 ROI 不等于身份跟踪，必须人工复核。": "Person indices apply within each frame only; a fixed ROI is not identity tracking. Human review is required.",
    "同一运动员的连续帧不是独立受试者；趋势不代表训练的因果效果。": "Consecutive frames of one athlete are not independent participants; trends do not establish causal training effects."
};
// Python's .4f rounds the exact binary value to even; toFixed rounds ties away.
function fixed4(value: number): string {
    if (!Number.isFinite(value))
        return String(value).toLowerCase();
    const bits = new DataView(new ArrayBuffer(8));
    bits.setFloat64(0, value);
    const raw = bits.getBigUint64(0), exponent = Number((raw >> 52n) & 0x7ffn);
    const significand = (raw & ((1n << 52n) - 1n)) + (exponent ? 1n << 52n : 0n);
    const power = (exponent || 1) - 1023 - 52;
    const numerator = significand * 10000n * (power >= 0 ? 1n << BigInt(power) : 1n);
    const denominator = power < 0 ? 1n << BigInt(-power) : 1n;
    let rounded = numerator / denominator;
    const remainder = numerator % denominator;
    if (remainder * 2n > denominator || (remainder * 2n === denominator && rounded % 2n))
        rounded++;
    const digits = rounded.toString().padStart(5, '0');
    return (raw >> 63n ? '-' : '') + digits.slice(0, -4) + '.' + digits.slice(-4);
}
export function rulesDraft(facts: Row, language = 'zh'): string {
    if (facts.kind === 'pose3d') {
        const s = facts.summary;
        return language === 'en' ? `Evidence-based review draft (rules; pending human confirmation)\n3D skeleton: ${s.frame_count ?? 0} sampled frames; ${s.track_count ?? 0} tracklets.\nRoot-relative model units; check posture and occlusion against the source video. No calibrated distances, force or ability score are inferred.` : `数据规则辅助复盘草稿（非生成式 AI；待人工确认）\n三维骨架：${s.frame_count ?? 0} 个采样帧，${s.track_count ?? 0} 条轨迹。\n使用根节点相对模型单位；请结合原片核对姿态与遮挡，不推断真实距离、力量或能力得分。`;
    }
    if (facts.kind === 'segmentation') {
        const s = facts.summary || {}, n = s.segmented_frames ?? '?', total = s.total_frames ?? '?';
        return language === 'en' ? `Evidence-based review draft (rules; pending human confirmation)\nSegmentation evidence: ${n}/${total} sampled frames contain masks. Object regions: ${s.object_count ?? 0}.\nCheck the target, occlusions and mask boundaries against the video. Masks do not establish identity, technique, outcome or score.` : `数据规则辅助复盘草稿（非生成式 AI；待人工确认）\n分割证据：${n}/${total} 个采样帧包含遮罩；检测区域数：${s.object_count ?? 0}。\n请逐帧核对目标、遮挡和遮罩边界；人物遮罩不能确认身份、技术、动作结果或得分。`;
    }
    if (language === 'en') {
        const lines = ['Evidence-based review draft (rules; pending human confirmation)'];
        if (facts.kind === 'recognition')
            lines.push(`Model action candidate: ${facts.candidate_label}.`, 'Confirm the action, performer and outcome against the source frames.');
        else {
            if (facts.synthetic)
                lines.push("Synthetic example: unrelated to the uploaded video's real performance; do not evaluate an athlete from these values.");
            const q = facts.quality;
            lines.push(`Evidence: ${q.usable_frames}/${q.total_frames} usable frames; ${q.ambiguous_frames} frames with multiple-person ambiguity.`);
            const labels: Row = {
                hip_sway_ratio: 'Lateral hip midpoint dispersion',
                trunk_lean_deg: 'Mean trunk lean',
                ankle_span_ratio: 'Mean 2D ankle span'
            };
            for (const [name, raw] of Object.entries(facts.metrics)) {
                const metric = mapping(raw), label = labels[name] ?? metric.label ?? name, unit = ({ '躯干长度': 'torso lengths', '°': 'deg' } as Row)[metric.unit] ?? metric.unit;
                lines.push(metric.value !== null ? `${label}: ${fixed4(metric.value)} ${unit} (image-plane measurement).` : `${label}: insufficient observations; no value reported.`);
            }
            lines.push('Check the person, occlusion, camera and clip interval with the athlete or coach. Compare repeated recordings under matching conditions.', 'Specialty scoring is unvalidated; no ability score is generated.');
        }
        lines.push(...(facts.limitations || []).map((item: string) => 'Limitations: ' + (LIMITATIONS_EN[item] ?? item)));
        return lines.join('\n');
    }
    if (facts.kind === 'recognition')
        return `数据规则辅助复盘草稿（非生成式 AI；待人工确认）\n模型动作候选：${facts.candidate_label}。\n请结合原片采样画面确认动作、执行者和结果。\n` + (facts.limitations || []).map((item: string) => '限制：' + item).join('\n');
    const q = facts.quality, lines = ['数据规则辅助复盘草稿（非生成式 AI；待人工确认）'];
    if (facts.synthetic)
        lines.push('合成样例：以下内容与上传视频的真实运动表现无关，不能作为训练评价。');
    lines.push(`数据证据：${q.usable_frames}/${q.total_frames} 帧可用；${q.ambiguous_frames} 帧存在多人歧义。`);
    for (const raw of Object.values(facts.metrics)) {
        const metric = mapping(raw);
        lines.push(metric.value !== null ? `${metric.label}：${fixed4(metric.value)} ${metric.unit}；仅描述图像平面测量。` : `${metric.label}：观测不足，暂不报告数值。`);
    }
    lines.push('待核实：确认分析人物、遮挡、机位及动作区间；数值变化不能单独说明技术好坏。', '下一步参考：在相同机位和训练条件下重复采集，由运动员/教练结合视频记录观察。', '专项得分未标定，未生成能力评分。', ...(facts.limitations || []).map((item: string) => '限制：' + item));
    return lines.join('\n');
}
