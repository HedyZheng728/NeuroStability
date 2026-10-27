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
    if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
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
export function navigate(path: string) { window.location.hash = path; }
