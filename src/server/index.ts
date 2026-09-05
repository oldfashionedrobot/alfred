import index from '../client/index.html'
import { initDb } from './db.ts'
import { handleApi } from './routes.ts'

initDb()

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  development: process.env.NODE_ENV !== 'production',
  routes: {
    // Bun bundles the client from the HTML entrypoint — no Vite, no separate build.
    '/*': index,
    '/api/*': (req: Request) => handleApi(req),
  },
})

console.log(`alfred → http://localhost:${server.port}`)
