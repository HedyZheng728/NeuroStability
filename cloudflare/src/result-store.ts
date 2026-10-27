import { APIError, epoch, sha256 } from './auth';

const MAX_BYTES = 16 * 1024 * 1024, PART_BYTES = 8 * 1024 * 1024, CHUNK_BYTES = 192 * 1024;
type Options = { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> };
type Part = { partNumber: number; etag: string };
function jsonKey(key: string, options?: Options) {
    if (!key.endsWith('.json') || (options?.httpMetadata?.contentType && options.httpMetadata.contentType.split(';')[0].trim() !== 'application/json'))
        throw new APIError(409, 'local_media_only: 云端仅保存 application/json 结果，视频与模型保留在本地');
}
function bytes(value: ArrayBuffer | ArrayBufferView | string): Uint8Array {
    return typeof value === 'string' ? new TextEncoder().encode(value) : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new Uint8Array(value);
}
function base64(data: Uint8Array) {
    let raw = '';
    for (let offset = 0; offset < data.length; offset += 8192) raw += String.fromCharCode(...data.subarray(offset, offset + 8192));
    return btoa(raw);
}
function descriptor(row: any) {
    return row ? { key: row.key, size: row.size_bytes, etag: row.sha256, httpEtag: `"${row.sha256}"`, uploaded: new Date(row.uploaded), httpMetadata: { contentType: 'application/json' }, customMetadata: { ...JSON.parse(row.metadata), sha256: row.sha256 } } : null;
}
/** R2's small object subset, backed by bounded D1 rows; raw video never enters D1. */
export class D1ResultStore {
    readonly resultsOnly = true;
    constructor(private DB: D1Database) {}
    async head(key: string) { return descriptor(await this.DB.prepare('SELECT * FROM result_objects WHERE key=?').bind(key).first()); }
    private async read(uploadId: string) {
        const rows = (await this.DB.prepare('SELECT data FROM result_chunks WHERE upload_id=? ORDER BY part_number,chunk_number').bind(uploadId).all<{ data: string }>()).results;
        const size = rows.reduce((n, row) => n + row.data.length / 4 * 3 - (row.data.endsWith('==') ? 2 : row.data.endsWith('=') ? 1 : 0), 0);
        if (size > MAX_BYTES) throw new APIError(413, 'JSON 结果不能超过16MiB');
        const out = new Uint8Array(size); let offset = 0;
        for (const row of rows) { const raw = atob(row.data); for (let i = 0; i < raw.length; i++) out[offset++] = raw.charCodeAt(i); }
        return out;
    }
    async get(key: string, options?: { range?: { offset: number; length?: number } }) {
        const row: any = await this.DB.prepare('SELECT * FROM result_objects WHERE key=?').bind(key).first();
        if (!row) return null;
        let data = await this.read(row.upload_id);
        if (data.length !== row.size_bytes || await sha256(data.buffer as ArrayBuffer) !== row.sha256) throw new APIError(502, 'JSON 结果完整性校验失败');
        if (options?.range) data = data.slice(options.range.offset, options.range.length === undefined ? undefined : options.range.offset + options.range.length);
        const buffer = data.buffer as ArrayBuffer;
        return { ...descriptor(row)!, body: new Blob([buffer]).stream(), arrayBuffer: async () => buffer, text: async () => new TextDecoder().decode(data), json: async () => JSON.parse(new TextDecoder().decode(data)) };
    }
    async put(key: string, value: ArrayBuffer | ArrayBufferView | string, options: Options = {}) {
        jsonKey(key, options);
        const data = bytes(value);
        if (!data.length || data.length > MAX_BYTES) throw new APIError(413, 'JSON 结果大小必须在1字节至16MiB之间');
        const upload = await this.createMultipartUpload(key, options);
        try {
            const parts = [];
            for (let offset = 0; offset < data.length; offset += PART_BYTES) parts.push(await upload.uploadPart(parts.length + 1, data.subarray(offset, offset + PART_BYTES)));
            return await upload.complete(parts);
        } catch (error) { await upload.abort(); throw error; }
    }
    async createMultipartUpload(key: string, options: Options = {}) {
        jsonKey(key, options);
        const uploadId = crypto.randomUUID();
        await this.DB.prepare('INSERT INTO result_uploads(id,key,metadata,created_at) VALUES(?,?,?,?)').bind(uploadId, key, JSON.stringify(options.customMetadata || {}), Math.floor(Date.now() / 1000)).run();
        return this.resumeMultipartUpload(key, uploadId);
    }
    resumeMultipartUpload(key: string, uploadId: string) {
        const manifest = async () => {
            const row: any = await this.DB.prepare('SELECT * FROM result_uploads WHERE id=? AND key=?').bind(uploadId, key).first();
            if (!row) throw new APIError(404, 'JSON 分片上传不存在');
            return row;
        };
        return { key, uploadId,
            uploadPart: async (partNumber: number, value: ArrayBuffer | ArrayBufferView | string) => {
                const upload = await manifest();
                if (upload.state !== 'open') throw new APIError(409, 'JSON 分片正在完成');
                const data = bytes(value);
                if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 2) throw new APIError(422, 'JSON 分片编号无效');
                if (!data.length || data.length > PART_BYTES) throw new APIError(413, 'JSON 分片大小必须在1字节至8MiB之间');
                const etag = await sha256(data.slice().buffer as ArrayBuffer), statements = [this.DB.prepare("DELETE FROM result_chunks WHERE upload_id=? AND part_number=? AND EXISTS(SELECT 1 FROM result_uploads WHERE id=? AND state='open')").bind(uploadId, partNumber, uploadId)];
                for (let offset = 0; offset < data.length; offset += CHUNK_BYTES) statements.push(this.DB.prepare("INSERT INTO result_chunks(upload_id,part_number,chunk_number,data) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM result_uploads WHERE id=? AND state='open')").bind(uploadId, partNumber, offset / CHUNK_BYTES, base64(data.subarray(offset, offset + CHUNK_BYTES)), uploadId));
                statements.push(this.DB.prepare("INSERT INTO result_parts(upload_id,part_number,size_bytes,etag) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM result_uploads WHERE id=? AND state='open') ON CONFLICT(upload_id,part_number) DO UPDATE SET size_bytes=excluded.size_bytes,etag=excluded.etag").bind(uploadId, partNumber, data.length, etag, uploadId));
                const results = await this.DB.batch(statements);
                if (!results.at(-1)!.meta.changes) throw new APIError(409, 'JSON 分片正在完成');
                return { partNumber, etag };
            },
            complete: async (parts: Part[]) => {
                const upload = await manifest();
                const finalizeToken = crypto.randomUUID();
                const lock = await this.DB.prepare("UPDATE result_uploads SET state='finalizing',finalize_token=?,finalize_until=? WHERE id=? AND (state='open' OR (state='finalizing' AND finalize_until<=?))").bind(finalizeToken, epoch() + 120, uploadId, epoch()).run();
                if (!lock.meta.changes) throw new APIError(409, 'JSON 分片正在完成');
                try {
                    const saved = (await this.DB.prepare('SELECT * FROM result_parts WHERE upload_id=? ORDER BY part_number').bind(uploadId).all<any>()).results;
                    if (!parts.length || parts.length !== saved.length || parts.some((p, i) => p.partNumber !== i + 1 || p.partNumber !== saved[i].part_number || p.etag !== saved[i].etag)) throw new APIError(422, 'JSON 分片校验失败');
                    const data = await this.read(uploadId);
                    if (!data.length || data.length > MAX_BYTES) throw new APIError(413, 'JSON 结果不能超过16MiB');
                    let parsed;
                    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(data)); } catch { throw new APIError(422, '结果 JSON 无效'); }
                    if (parsed === null || typeof parsed !== 'object') throw new APIError(422, '结果 JSON 必须是对象或数组');
                    const digest = await sha256(data.buffer as ArrayBuffer), metadata = JSON.parse(upload.metadata);
                    if (metadata.sha256 && metadata.sha256 !== digest) throw new APIError(422, 'JSON 结果 SHA256 校验失败');
                    const old: any = await this.DB.prepare('SELECT upload_id FROM result_objects WHERE key=?').bind(key).first();
                    const statements = [
                        this.DB.prepare("INSERT INTO result_objects(key,upload_id,size_bytes,sha256,metadata,uploaded) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM result_uploads WHERE id=? AND state='finalizing' AND finalize_token=? AND finalize_until>?) ON CONFLICT(key) DO UPDATE SET upload_id=excluded.upload_id,size_bytes=excluded.size_bytes,sha256=excluded.sha256,metadata=excluded.metadata,uploaded=excluded.uploaded").bind(key, uploadId, data.length, digest, upload.metadata, new Date().toISOString(), uploadId, finalizeToken, epoch()),
                        this.DB.prepare('DELETE FROM result_parts WHERE upload_id=? AND EXISTS(SELECT 1 FROM result_uploads WHERE id=? AND finalize_token=?) AND EXISTS(SELECT 1 FROM result_objects WHERE key=? AND upload_id=?)').bind(uploadId, uploadId, finalizeToken, key, uploadId),
                        this.DB.prepare('DELETE FROM result_uploads WHERE id=? AND finalize_token=? AND EXISTS(SELECT 1 FROM result_objects WHERE key=? AND upload_id=?)').bind(uploadId, finalizeToken, key, uploadId)
                    ];
                    if (old && old.upload_id !== uploadId) statements.push(this.DB.prepare('DELETE FROM result_chunks WHERE upload_id=? AND NOT EXISTS(SELECT 1 FROM result_objects WHERE upload_id=?)').bind(old.upload_id, old.upload_id));
                    const published = await this.DB.batch(statements);
                    if (!published[0].meta.changes) throw new APIError(409, 'JSON 分片完成租约已失效');
                    return (await this.head(key))!;
                } catch (error) {
                    await this.DB.prepare("UPDATE result_uploads SET state='open',finalize_token=NULL,finalize_until=0 WHERE id=? AND finalize_token=?").bind(uploadId, finalizeToken).run();
                    throw error;
                }
            },
            abort: async () => {
                await this.DB.batch([
                    this.DB.prepare("DELETE FROM result_chunks WHERE upload_id=? AND NOT EXISTS(SELECT 1 FROM result_objects WHERE upload_id=?) AND EXISTS(SELECT 1 FROM result_uploads WHERE id=? AND (state='open' OR finalize_until<=?))").bind(uploadId, uploadId, uploadId, epoch()),
                    this.DB.prepare("DELETE FROM result_parts WHERE upload_id=? AND EXISTS(SELECT 1 FROM result_uploads WHERE id=? AND (state='open' OR finalize_until<=?))").bind(uploadId, uploadId, epoch()),
                    this.DB.prepare("DELETE FROM result_uploads WHERE id=? AND key=? AND (state='open' OR finalize_until<=?)").bind(uploadId, key, epoch())
                ]);
            }
        };
    }
    async delete(keys: string | string[]) {
        for (const key of typeof keys === 'string' ? [keys] : keys) {
            await this.DB.batch([this.DB.prepare('DELETE FROM result_chunks WHERE upload_id IN(SELECT upload_id FROM result_objects WHERE key=? UNION SELECT id FROM result_uploads WHERE key=?)').bind(key, key), this.DB.prepare('DELETE FROM result_parts WHERE upload_id IN(SELECT id FROM result_uploads WHERE key=?)').bind(key), this.DB.prepare('DELETE FROM result_uploads WHERE key=?').bind(key), this.DB.prepare('DELETE FROM result_objects WHERE key=?').bind(key)]);
        }
    }
    async list(options: { prefix?: string; cursor?: string; limit?: number } = {}) {
        const limit = Math.min(1000, Math.max(1, options.limit || 1000)), prefix = options.prefix || '';
        const rows = (await this.DB.prepare('SELECT * FROM result_objects WHERE substr(key,1,?)=? AND key>? ORDER BY key LIMIT ?').bind(prefix.length, prefix, options.cursor || '', limit + 1).all()).results;
        const truncated = rows.length > limit, objects = rows.slice(0, limit).map(descriptor);
        return { objects, truncated, cursor: truncated ? objects.at(-1)!.key : undefined };
    }
}
