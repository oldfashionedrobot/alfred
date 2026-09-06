import type { DayView, TodoView, HistoryView, ISODate } from '../shared/types.ts'

/**
 * The whole client/server surface. Queries return view models; commands return
 * nothing and the caller refetches the view it is on.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
  /** The model refused the gesture — the write did not happen. */
  get rejected(): boolean {
    return this.status === 409
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (res.status === 401) {
    // Being signed out is not a failure of the gesture, and an error notice
    // behind a screen you cannot use helps nobody. The navigation IS the
    // outcome, so this never resolves — settling it would let the caller render
    // an error for the half-second before the page goes away.
    window.location.href = '/login'
    await new Promise(() => {})
  }
  if (!res.ok) {
    let message = res.statusText
    try {
      const body = (await res.json()) as { error?: string }
      if (body?.error) message = body.error
    } catch {
      // non-JSON error body; statusText stands
    }
    throw new ApiError(res.status, message)
  }
  return (await res.json()) as T
}

export const getDay = () => request<DayView>('/day')
export const getTodo = () => request<TodoView>('/todo')

export function getHistory(opts: { limit?: number; before?: ISODate } = {}) {
  const q = new URLSearchParams()
  if (opts.limit != null) q.set('limit', String(opts.limit))
  if (opts.before != null) q.set('before', opts.before)
  const qs = q.toString()
  return request<HistoryView>(`/history${qs ? `?${qs}` : ''}`)
}

/** Fire a named command. Returns nothing — refetch the current view after. */
export async function command(name: string, body: Record<string, unknown> = {}): Promise<void> {
  await request<{ ok: true }>(`/commands/${name}`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/**
 * One place errors become text. A 409 means the model refused the gesture and
 * the write did not happen — worth saying so, since the screen is still accurate.
 */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.rejected ? `Not allowed: ${e.message}` : e.message
  return e instanceof Error ? e.message : String(e)
}
