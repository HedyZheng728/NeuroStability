/** Cookie authentication. Browser proofs avoid Workers' 100k PBKDF2 iteration limit. */
export class APIError extends Error {
    constructor(public status: number, message: string) { super(message); }
}
export const now = () => new Date().toISOString();
export const epoch = () => Math.floor(Date.now() / 1000);
export const hex = (data: ArrayBuffer | Uint8Array) => [...new Uint8Array(data)].map(v => v.toString(16).padStart(2, '0')).join('');
export const sha256 = async (value: string | ArrayBuffer) => hex(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? new TextEncoder().encode(value) : value));
export const json = (value: any, status = 200, headers: HeadersInit = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
export function equal(a: string, b: string) { let diff = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++)
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return diff === 0; }
export function object(value: any, allowed: string[]) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k)))
    throw new APIError(422, '输入包含不支持的字段'); return value; }
export async function body(req: Request, allowed: string[], max = 1024 * 1024) {
    if (Number(req.headers.get('content-length') || 0) > max)
        throw new APIError(413, '请求过大');
    const reader = req.body?.getReader();
    if (!reader)
        throw new APIError(422, 'JSON 无效');
    const decoder = new TextDecoder();
    let raw = '', size = 0;
    for (;;) {
        const { value, done } = await reader.read();
        if (done)
            break;
        size += value.byteLength;
        if (size > max) {
            await reader.cancel();
            throw new APIError(413, '请求过大');
        }
        raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
    let data;
    try {
        data = JSON.parse(raw);
    }
    catch {
        throw new APIError(422, 'JSON 无效');
    }
    return object(data, allowed);
}
export function text(value: any, max: number, min = 0, fallback?: string) { if (value === undefined && fallback !== undefined)
    value = fallback; if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max)
    throw new APIError(422, '文字长度无效'); return value.trim(); }
export function number(value: any, min: number, max: number, integer = false) { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)))
    throw new APIError(422, '数值无效'); return value; }
export function choice(value: any, values: string[], fallback?: string) { if (value === undefined)
    value = fallback; if (!values.includes(value))
    throw new APIError(422, '选项无效'); return value as string; }
export function boolean(value: any, fallback = false) { if (value === undefined)
    return fallback; if (typeof value !== 'boolean')
    throw new APIError(422, '布尔值无效'); return value; }
export function date(value: any) { const s = text(value, 10, 10); if (s.startsWith('0000') || !/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString().slice(0, 10) !== s)
    throw new APIError(422, '日期无效'); return s; }
export async function attempt(req: Request, env: any) {
    const client = await sha256(req.headers.get('cf-connecting-ip') || 'unknown');
    const result = await env.DB.batch([env.DB.prepare('DELETE FROM login_attempts WHERE created < ?').bind(epoch() - 300), env.DB.prepare('INSERT INTO login_attempts(id,client,created) SELECT ?,?,? WHERE (SELECT count(*) FROM login_attempts WHERE client=?)<10').bind(crypto.randomUUID(), client, epoch(), client)]);
    if (!result[1].meta.changes)
        throw new APIError(429, '登录尝试过多，请5分钟后重试');
}
export async function challenge(req: Request, env: any) {
    await attempt(req, env);
    const p = await body(req, ['username']);
    const username = text(p.username, 80, 1);
    const user = await env.DB.prepare('SELECT password_hash FROM users WHERE username=?').bind(username).first();
    const id = crypto.randomUUID(), nonce = crypto.randomUUID() + crypto.randomUUID();
    await env.DB.batch([env.DB.prepare('DELETE FROM login_challenges WHERE expires < ?').bind(epoch()), env.DB.prepare('INSERT INTO login_challenges(id,username,nonce,expires) VALUES(?,?,?,?)').bind(id, username, nonce, epoch() + 120)]);
    return json({ challenge_id: id, salt: user ? user.password_hash.split(':')[0] : hex(crypto.getRandomValues(new Uint8Array(16))), nonce, iterations: 260000, algorithm: 'PBKDF2-SHA256/HMAC-SHA256' });
}
export async function login(req: Request, env: any) {
    const p = await body(req, ['username', 'password', 'challenge_id', 'proof']);
    const username = text(p.username, 80, 1);
    const user = await env.DB.prepare('SELECT * FROM users WHERE username=?').bind(username).first();
    let valid = false;
    if (p.challenge_id !== undefined) {
        const c = await env.DB.prepare('DELETE FROM login_challenges WHERE id=? AND username=? AND expires>? RETURNING *').bind(text(p.challenge_id, 36, 1), username, epoch()).first();
        if (c && user && typeof p.proof === 'string' && /^[a-f0-9]{64}$/.test(p.proof)) {
            const key = await crypto.subtle.importKey('raw', Uint8Array.from(user.password_hash.split(':')[1].match(/../g), (v: any) => parseInt(v, 16)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
            valid = equal(hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(c.nonce))), p.proof);
        }
    }
    else {
        await attempt(req, env);
        text(p.password, 300, 1);
        throw new APIError(409, '请使用浏览器安全登录流程');
    }
    if (!valid)
        throw new APIError(401, '用户名或密码错误');
    const raw = hex(crypto.getRandomValues(new Uint8Array(32))), csrf = hex(crypto.getRandomValues(new Uint8Array(32)));
    await env.DB.batch([env.DB.prepare('DELETE FROM auth_sessions WHERE expires<?').bind(epoch()), env.DB.prepare('INSERT INTO auth_sessions(id,user_id,csrf,expires) VALUES(?,?,?,?)').bind(await sha256(raw), user.id, csrf, epoch() + 28800)]);
    return json({ username: user.username, csrf, timezone: env.ARENA_TIMEZONE || 'Asia/Shanghai' }, 200, { 'set-cookie': cookie(req, raw, 28800) });
}
export function cookie(req: Request, value: string, maxAge: number) { return `arena_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${new URL(req.url).protocol === 'https:' ? '; Secure' : ''}`; }
export async function authenticate(req: Request, env: any) { const raw = req.headers.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith('arena_session='))?.slice(14); if (!raw)
    throw new APIError(401, '请先登录'); const auth = await env.DB.prepare('SELECT a.*,u.username FROM auth_sessions a JOIN users u ON u.id=a.user_id WHERE a.id=? AND a.expires>?').bind(await sha256(raw), epoch()).first(); if (!auth)
    throw new APIError(401, '请先登录'); if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !equal(req.headers.get('x-csrf-token') || '', auth.csrf))
    throw new APIError(403, 'CSRF 校验失败，请刷新后重试'); return auth; }
export function workerAuth(req: Request, env: any) { if (!env.ARENA_WORKER_TOKEN || !equal(req.headers.get('authorization') || '', `Bearer ${env.ARENA_WORKER_TOKEN}`))
    throw new APIError(401, 'Worker 认证失败'); }
