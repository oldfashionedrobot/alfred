import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The routes for a client built ahead of time — `bun run build:client`, which the
 * Dockerfile runs — from the directory it was built into.
 *
 * Production only. Development keeps `Bun.serve`'s HTML import, which bundles on
 * the first request and reloads on save; `index.ts` chooses by `CLIENT_DIST`.
 *
 * WHY BUILT AHEAD. The HTML import always emits one script, so every page paid for
 * the notes editor, and bundling on the machine roughly doubled the process — 71
 * MB to 143 MB, measured — on a machine with 256. Built with `--splitting`, the
 * Notes tab is a chunk of its own, fetched the first time it is opened.
 *
 * THE LAYOUT is flat: `index.html` and every hashed file side by side in the
 * directory, served under `/assets/` — the build's `--public-path`, which every
 * reference in the HTML and the scripts already carries.
 *
 *   /assets/<name>   one exact route per file, cached forever: the name is
 *                    content-hashed, so a changed file is a new name
 *   /assets/*        anything else under it is a 404 — not the page with a 200,
 *                    which would hand a stale tab HTML where it asked for script
 *   /*               the page, `no-cache`, so every load checks it and a deploy
 *                    is picked up on the next one
 *
 * The routes are made ONCE, from the directory listing, at boot. Nothing in a
 * request ever reaches the filesystem, so there is no path to sanitise. A
 * directory without a page in it stops the boot: Fly refuses a release whose
 * machine crash-loops, where a server answering 404 to everything would ship.
 *
 * Bun answers HEAD on these routes itself, sets the content type from the file
 * and adds Last-Modified. A POST to an asset gets Bun's own 400 rather than this
 * app's 404 for a wrong method — accepted, not written around.
 */
export function builtClient(dir: string): Record<string, Response> {
  const page = join(dir, 'index.html')
  if (!existsSync(page)) {
    throw new Error(`CLIENT_DIST is ${dir}, which holds no index.html — run bun run build:client`)
  }

  const routes: Record<string, Response> = {}
  for (const name of readdirSync(dir)) {
    if (name === 'index.html') continue
    routes[`/assets/${name}`] = new Response(Bun.file(join(dir, name)), {
      headers: { 'cache-control': 'public, max-age=31536000, immutable' },
    })
  }
  routes['/assets/*'] = new Response('Not found', { status: 404 })
  routes['/*'] = new Response(Bun.file(page), { headers: { 'cache-control': 'no-cache' } })
  return routes
}
