/**
 * Bun's own types (`bun-types/extensions.d.ts`) declare `*.txt`, `*.toml`,
 * `*.yaml`, `*.json5`, `*.html` and more — but not `*.css`. So every
 * `import './day.css'` is a module TypeScript cannot resolve.
 *
 * It went unnoticed because `import './x.css'` is a SIDE-EFFECT import, and
 * TypeScript does not check those unless `noUncheckedSideEffectImports` is on.
 * The compiler said nothing; editors with the flag enabled reported ts(2882) on
 * every view. That flag is now on in tsconfig.json, so the two agree.
 *
 * The body is deliberately empty. Bun bundles the file and links it into the
 * page; there is no value to import, and an empty module means
 * `import styles from './day.css'` is an error rather than silently `any`.
 *
 * What this does NOT do is catch a mistyped filename: the wildcard matches any
 * `.css` path, so `import './dya.css'` still typechecks. Only an extension
 * nothing declares — `./day.scss`, say — is caught. A missing stylesheet shows
 * up as an unstyled screen, which the Playwright suite would notice long before
 * the compiler could.
 */
declare module '*.css' {}
