export class ApiError extends Error { constructor(message: string, public status: number, public code?: string) { super(message); } }
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  let response: Response;
  try { response = await fetch(`/api${path}`, { ...options, headers, credentials: 'same-origin' }); }
  catch { throw new ApiError('网络连接中断，请稍后重试。已提交的任务可在作品中查看。', 0); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.error || '请求未能完成，请稍后重试', response.status, data.code);
  return data as T;
}
export const post = <T>(path: string, body: unknown, headers?: Record<string, string>) => api<T>(path, { method: 'POST', body: JSON.stringify(body), headers });
