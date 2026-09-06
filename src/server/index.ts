import index from '../client/index.html'
import {
  assertAuthConfigured,
  authenticate,
  clearedCookie,
  loginPage,
  sessionCookie,
} from './auth.ts'
import { db, initDb } from './db.ts'
import { handleApi } from './routes.ts'

// Before anything listens: a production server with the door open should not
// start at all. See `assertAuthConfigured`.
assertAuthConfigured()

// Top-level await: the server must not accept a request before the schema
// exists and, on a replica, before the first sync has landed.
await initDb()

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  development: process.env.NODE_ENV !== 'production',
  routes: {
    /*
     * Auth is server-side end to end. The password never reaches the client
     * bundle, and the login page is plain HTML rather than a React view.
     *
     * The bundle at `/*` is NOT gated, and cannot be: a Bun route handler can
     * return a Response but not an HTMLBundle, so there is no way to serve the
     * app conditionally. Verified rather than assumed. It matters less than it
     * reads — the repository is public, so the bundle is not a secret — and an
     * unauthenticated visitor is bounced here by the client the moment its
     * first request comes back 401.
     */
    '/login': {
      GET: () => loginPage(),
      POST: async (req: Request) => {
        const form = await req.formData()
        const user = await authenticate(
          db,
          String(form.get('username') ?? ''),
          String(form.get('password') ?? ''),
        )
        // One message for every failure — unknown name, wrong password, disabled
        // account. Telling them apart only helps someone finding out which names
        // are real.
        if (user === null) return loginPage('That name and password did not match.')
        return new Response(null, {
          status: 303,
          headers: { location: '/', 'set-cookie': sessionCookie(user) },
        })
      },
    },
    // POST, so SameSite=Lax means a cross-site link cannot sign you out.
    '/logout': {
      POST: () =>
        new Response(null, {
          status: 303,
          headers: { location: '/login', 'set-cookie': clearedCookie() },
        }),
    },
    '/api/*': (req: Request) => handleApi(req),
    // Bun bundles the client from the HTML entrypoint — no Vite, no separate build.
    '/*': index,
  },
})

console.log(`alfred → http://localhost:${server.port}`)
