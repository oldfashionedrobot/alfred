import { execFileSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Playwright's global setup: `bun run build:client`, once, before any project —
 * the same command the Dockerfile runs, so the `built` project tests what ships.
 * It takes about 50 ms, so it runs whichever projects were asked for.
 */
export default function buildClient(): void {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  try {
    execFileSync('bun', ['run', 'build:client'], { cwd: root, stdio: 'pipe' })
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer }
    throw new Error(`bun run build:client failed\n${err.stdout ?? ''}${err.stderr ?? ''}`)
  }
}
