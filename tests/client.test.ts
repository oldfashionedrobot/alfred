import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'bun'
import { builtClient } from '../src/server/client.ts'

/**
 * The built client's routes, against a real `Bun.serve` — the ranking of exact,
 * `/assets/*` and `/*` routes is Bun's, and only a server answers for it.
 *
 * The directory stands in for `bun run build:client`'s output: a page and some
 * hashed files, flat.
 */

const IMMUTABLE = 'public, max-age=31536000, immutable'

let dir: string
let server: Server<undefined>
let base: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'alfred-client-'))
  writeFileSync(
    join(dir, 'index.html'),
    '<!doctype html><script src="/assets/index-abc123.js"></script>',
  )
  writeFileSync(join(dir, 'index-abc123.js'), 'console.log("entry")')
  writeFileSync(join(dir, 'Notes-def456.js'), 'export default 1')
  writeFileSync(join(dir, 'index-ghi789.css'), 'body{}')
  server = Bun.serve({
    port: 0,
    development: false,
    routes: { '/api/*': () => Response.json({ api: true }), ...builtClient(dir) },
  })
  base = `http://localhost:${server.port}`
})

afterAll(() => {
  server.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

describe('builtClient', () => {
  test('each file is served under /assets/, cached forever, with its type', async () => {
    for (const [name, type] of [
      ['index-abc123.js', 'javascript'],
      ['Notes-def456.js', 'javascript'],
      ['index-ghi789.css', 'text/css'],
    ] as const) {
      const res = await fetch(`${base}/assets/${name}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe(IMMUTABLE)
      expect(res.headers.get('content-type')).toContain(type)
    }
    expect(await (await fetch(`${base}/assets/Notes-def456.js`)).text()).toBe('export default 1')
  })

  test('the page answers every other path, and is never cached', async () => {
    for (const path of ['/', '/claim?t=abc', '/anything/else']) {
      const res = await fetch(`${base}${path}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
      expect(res.headers.get('cache-control')).toBe('no-cache')
      expect(await res.text()).toContain('/assets/index-abc123.js')
    }
  })

  test('an unknown asset is a 404, not the page', async () => {
    // A tab opened before a deploy asks for a chunk the new build does not
    // have. HTML with a 200 there would be a script that fails to parse.
    const res = await fetch(`${base}/assets/Notes-oldhash.js`)
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).not.toContain('text/html')
  })

  test('the page is not also an asset', async () => {
    expect((await fetch(`${base}/assets/index.html`)).status).toBe(404)
  })

  test('the API is still the API', async () => {
    expect(await (await fetch(`${base}/api/status`)).json()).toEqual({ api: true })
  })

  test('HEAD is answered', async () => {
    const res = await fetch(`${base}/assets/index-abc123.js`, { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe(IMMUTABLE)
  })

  test('a directory without a page stops the boot', () => {
    const empty = mkdtempSync(join(tmpdir(), 'alfred-empty-'))
    try {
      expect(() => builtClient(empty)).toThrow('holds no index.html')
      expect(() => builtClient(join(empty, 'missing'))).toThrow('holds no index.html')
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})
