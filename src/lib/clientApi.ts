// Browser-side JSON requests. Every UI call to our own API goes through here so
// a hung or failing request always ends in a readable message instead of a
// spinner that never stops: requests time out, non-JSON error pages (a Vercel
// 504, an HTML 500) are handled, and network failures are named as such.
//
// Only idempotent GETs are retried. A POST that timed out may still have been
// applied on the server, so it is never replayed automatically — the message
// tells the user to refresh and check before trying again.

export type ApiData = Record<string, unknown>

export type ApiResult<T = ApiData> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string; data: ApiData | null }

interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  /** Default 20s. Long admin jobs (bulk sync, broadcast) pass more. */
  timeoutMs?: number
  /** Extra attempts for GET on network errors and 502/503/504. Default 1. */
  retries?: number
}

const DEFAULT_TIMEOUT_MS = 20_000
const RETRYABLE_STATUS = new Set([502, 503, 504])

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function fallbackMessage(status: number, method: string): string {
  if (status === 401) return 'Your session has expired. Log in again and retry.'
  if (status === 403) return 'You do not have permission to do that.'
  if (status === 404) return 'That item no longer exists. Refresh the page.'
  if (status === 429) return 'Too many requests. Wait a minute and try again.'
  if (status >= 500) {
    return method === 'GET'
      ? 'The server is having trouble right now. Try again in a moment.'
      : 'The server had a problem saving that. Refresh to check whether it went through, then try again.'
  }
  return 'The request could not be completed.'
}

export async function apiRequest<T = ApiData>(url: string, options: ApiOptions = {}): Promise<ApiResult<T>> {
  const method = options.method ?? 'GET'
  const retries = method === 'GET' ? options.retries ?? 1 : 0
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  for (let attempt = 0; ; attempt++) {
    let response: Response
    try {
      response = await fetch(url, {
        method,
        cache: 'no-store',
        headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      if (attempt < retries) {
        await wait(500 * 2 ** attempt)
        continue
      }
      const timedOut = err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')
      const error = timedOut
        ? method === 'GET'
          ? 'The server took too long to respond. Try again.'
          : 'The server took too long to respond. Refresh to check whether it went through before trying again.'
        : 'Could not reach the server. Check your connection and try again.'
      return { ok: false, status: 0, error, data: null }
    }

    if (!response.ok && RETRYABLE_STATUS.has(response.status) && attempt < retries) {
      await wait(500 * 2 ** attempt)
      continue
    }

    const data = (await response.json().catch(() => null)) as ApiData | null
    if (response.ok) return { ok: true, status: response.status, data: (data ?? {}) as T }

    const serverError = typeof data?.error === 'string' && data.error ? data.error : null
    return {
      ok: false,
      status: response.status,
      error: serverError ?? fallbackMessage(response.status, method),
      data,
    }
  }
}
