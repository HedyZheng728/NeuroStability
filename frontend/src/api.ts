let csrf = '';
let unauthorized: (() => void) | undefined;
export function configureApi(token: string, onUnauthorized?: () => void) { csrf = token; unauthorized = onUnauthorized; }

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = 'ApiError'; }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  const method = options.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    if (csrf) headers.set('X-CSRF-Token', csrf);
    if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  }
  let response: Response;
  try { response = await fetch(`/api${path}`, { ...options, headers, credentials: 'same-origin' }); }
  catch { throw new ApiError("无法连接服务，请检查网络后重试。", 0); }
  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try {
      const body = await response.json();
      message = typeof body.detail === 'string' ? body.detail : typeof body.error === 'string' ? body.error : message;
      if (Array.isArray(body.detail)) message = body.detail.map((item: { msg?: string }) => item.msg || '字段不合法').join('; ');
    } catch { /* Keep the HTTP status when the server has no JSON error body. */ }
    if (response.status === 401 && path !== '/login' && path !== '/me') unauthorized?.();
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
export const post = <T,>(path: string, value: unknown) => api<T>(path, { method: 'POST', body: JSON.stringify(value) });
export const put = <T,>(path: string, value: unknown) => api<T>(path, { method: 'PUT', body: JSON.stringify(value) });

export async function loginAccount<T>(username: string, password: string): Promise<T> {
  username = username.trim(); password = password.trim();
  let health: Response;
  try { health = await fetch('/healthz', { credentials: 'same-origin' }); }
  catch { throw new ApiError('无法连接服务，请检查网络后重试。', 0); }
  if (!health.ok) throw new ApiError(`Service unavailable (${health.status})`, health.status);
  const capabilities = await health.json();
  if (capabilities.authentication !== 'browser-proof-v1') return post<T>('/login', { username, password });
  const challenge = await post<{ challenge_id: string; salt: string; nonce: string; iterations: number }>('/login/challenge', { username });
  if (challenge.iterations !== 260000 || !challenge.salt || !challenge.nonce || !challenge.challenge_id) throw new ApiError('Invalid login challenge', 422);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(challenge.salt), iterations: challenge.iterations }, key, 256);
  const signing = await crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const proof = [...new Uint8Array(await crypto.subtle.sign('HMAC', signing, encoder.encode(challenge.nonce)))].map(value => value.toString(16).padStart(2, '0')).join('');
  return post<T>('/login', { username, challenge_id: challenge.challenge_id, proof });
}

export type UploadConfig = { mode: 'multipart' | 'legacy'; max_size_bytes: number; part_size: number };
export async function uploadConfig(): Promise<UploadConfig> {
  try { return await api<UploadConfig>('/upload-config'); }
  catch (error) {
    if (error instanceof ApiError && error.status === 404) return { mode: 'legacy', max_size_bytes: 100 * 1024 * 1024, part_size: 8 * 1024 * 1024 };
    throw error;
  }
}

export async function uploadVideo<T>(file: File, fields: Record<string, string | boolean>, config: UploadConfig, progress?: (fraction: number) => void, signal?: AbortSignal): Promise<T> {
  if (!file.size || file.size > config.max_size_bytes) throw new ApiError('Video exceeds the upload size limit', 413);
  progress?.(0);
  if (config.mode === 'legacy') {
    const form = new FormData(); for (const [key, value] of Object.entries(fields)) form.set(key, String(value)); form.set('file', file);
    const video = await api<T>('/videos', { method: 'POST', body: form, signal }); progress?.(1); return video;
  }
  const upload = await api<{ id: string; part_size: number }>('/uploads', { method: 'POST', body: JSON.stringify({ ...fields, filename: file.name, size_bytes: file.size }), signal });
  if (!Number.isInteger(upload.part_size) || upload.part_size < 5 * 1024 * 1024 || upload.part_size > 8 * 1024 * 1024) throw new ApiError('Invalid upload part size', 422);
  async function send<R>(path: string, options: RequestInit): Promise<R> {
    for (let attempt = 0; ; attempt++) {
      try { return await api<R>(path, { ...options, signal }); }
      catch (error) {
        if (signal?.aborted || !(error instanceof ApiError) || ![0, 429, 500, 502, 503, 504].includes(error.status) || attempt >= 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
  }
  try {
    let part = 1;
    for (let offset = 0; offset < file.size; offset += upload.part_size, part++) {
      const chunk = file.slice(offset, Math.min(offset + upload.part_size, file.size));
      await send(`/uploads/${upload.id}/parts/${part}`, { method: 'PUT', body: chunk, headers: { 'Content-Type': 'application/octet-stream' } });
      progress?.(Math.min(offset + chunk.size, file.size) / file.size * .99);
    }
    const video = await send<T>(`/uploads/${upload.id}/complete`, { method: 'POST' }); progress?.(1); return video;
  } catch (error) {
    // Cancel only explicit cancellation. Network failures keep private parts for retry/expiry.
    if (signal?.aborted) await api(`/uploads/${upload.id}`, { method: 'DELETE' }).catch(() => {});
    throw error;
  }
}
export function navigate(path: string) { window.location.hash = path; }
