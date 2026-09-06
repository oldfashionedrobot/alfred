import index from '../client/index.html'
import { warnIfNobodyCanSignIn } from './auth.ts'
import { db, initDb } from './db.ts'
import { handleApi } from './routes.ts'

// Top-level await: the server must not accept a request before the schema
// exists and, on a replica, before the first sync has landed.
await initDb()
await warnIfNobodyCanSignIn(db)

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  development: process.env.NODE_ENV !== 'production',
  routes: {
    /*
     * Signing in is `POST /api/login`, and the form is a React view — see
     * `.plan/changes-v9.md`. There is no `/login` URL: the client owns the
     * signed-out state, so one place decides you are signed out rather than a
     * server route and a client route that have to agree with each other.
     */
    '/api/*': (req: Request) => handleApi(req),
    // Bun bundles the client from the HTML entrypoint — no Vite, no separate build.
    '/*': index,
  },
})

console.log(`alfred → http://localhost:${server.port}`)
