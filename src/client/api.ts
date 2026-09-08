import type { DayView, TodoView, HistoryView, ISODate } from '../shared/types.ts'

/**
 * The whole client/server surface. Queries return view models; commands return
 * nothing and the caller refetches the view it is on.
 *
 * This is also the only place a 401 is recognised. `main.tsx` registers a
 * listener and swaps the app for the login view, so every screen is spared
 * knowing whether it is signed in — the same reason view models arrive
 * pre-derived rather than assembled per screen.
 */

let signedOut: (() => void) | null = null

/** Registered once, by the shell. */
export function onSignedOut(fn: () => void): void {
  signedOut = fn
}

function notifySignedOut(): void {
  signedOut?.()
}

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
    // behind a screen you cannot use helps nobody. The app is replaced by the
    // login view instead, so this never resolves: settling it would let the
    // caller render an error for the frame before it unmounts.
    notifySignedOut()
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
 * Signing in. Deliberately NOT routed through `request`: a wrong password is a
 * 401, and `request` treats a 401 as "you have been signed out" and never
 * resolves — which is right everywhere else and would stop this form ever
 * showing an error.
 *
 * Returns null on success, or the message to show.
 */
export async function login(username: string, password: string): Promise<string | null> {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (res.ok) return null
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  return body.error ?? 'Could not sign in.'
}

/**
 * Spend an invitation: set a password and a zone, and end up signed in.
 *
 * The timezone is the DEVICE's, offered as a default the person can change —
 * it is stored against the user, so their day boundary follows them rather than
 * whatever they are holding.
 */
export async function claim(
  token: string,
  password: string,
  timezone: string,
): Promise<string | null> {
  const res = await fetch('/api/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, password, timezone }),
  })
  if (res.ok) return null
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  return body.error ?? 'Could not set up the account.'
}

export type Account = { username: string; timezone: string }

/** Who you are signed in as, and the zone your day rolls over in. */
export async function getAccount(): Promise<Account> {
  return (await (await fetch('/api/account')).json()) as Account
}

/** Null on success, else the message to show. */
export async function setTimezone(timezone: string): Promise<string | null> {
  return post('/api/account/timezone', { timezone }, 'Could not save that timezone.')
}

/**
 * Null on success, else the message to show.
 *
 * The response carries a fresh cookie signed with the NEW password hash, which
 * the browser stores like any other. That is what keeps this device signed in
 * while every other session this account has stops verifying.
 */
export async function changePassword(current: string, next: string): Promise<string | null> {
  return post('/api/account/password', { current, next }, 'Could not change the password.')
}

async function post(path: string, body: unknown, fallback: string): Promise<string | null> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (res.ok) return null
  const failed = (await res.json().catch(() => ({}))) as { error?: string }
  return failed.error ?? fallback
}

/** Clears the cookie server-side, then puts the app back to the login view. */
export async function logout(): Promise<void> {
  await fetch('/api/logout', { method: 'POST' })
  notifySignedOut()
}

/**
 * One place errors become text. A 409 means the model refused the gesture and
 * the write did not happen — worth saying so, since the screen is still accurate.
 */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.rejected ? `Not allowed: ${e.message}` : e.message
  return e instanceof Error ? e.message : String(e)
}
