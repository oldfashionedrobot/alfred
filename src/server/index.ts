import index from '../client/index.html'
import { warnIfNobodyCanSignIn } from './auth.ts'
import { builtClient } from './client.ts'
import { db, initDb } from './db.ts'
import { handleApi } from './routes.ts'

// Top-level await: the server must not accept a request before the schema
// exists and, on a replica, before the first sync has landed.
await initDb()
await warnIfNobodyCanSignIn(db)

/*
 * The client: built ahead and served from a directory when `CLIENT_DIST` names
 * one — the Dockerfile sets it — or bundled from the HTML import on the first
 * request otherwise, with hot reload, for development.
 *
 * Its own switch rather than NODE_ENV, deliberately: NODE_ENV=production also
 * marks the session cookie Secure, which the browser suite cannot use on
 * http://localhost, and the suite has to be able to test the built client.
 *
 * The HTML import stays a static import either way. Bun bundles it lazily, on
 * the first request for it, so in production — where nothing routes to it — it
 * is never bundled at all.
 */
const dist = process.env.CLIENT_DIST
const client: Record<string, Response | typeof index> = dist ? builtClient(dist) : { '/*': index }

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  development: process.env.NODE_ENV !== 'production',
  routes: {
    /*
     * Signing in is `POST /api/login`, and the form is a React view. There is
     * no `/login` URL: the client owns the signed-out state, so one place
     * decides you are signed out rather than a server route and a client
     * route that have to agree with each other.
     */
    '/api/*': (req: Request) => handleApi(req),
    ...client,
  },
})

console.log(`alfred → http://localhost:${server.port}`)
