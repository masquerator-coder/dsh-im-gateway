#!/usr/bin/env node
/**
 * esbuild build for dsh-im-gateway — emits BOTH halves of the plugin:
 *
 *   lib/index.js   node half   — the Cordis plugin entry (host-side).
 *   lib/client.js  browser half — a DSH client bundle aligned to the
 *                                 `window.__ModuleLoader__.load({id, factory})`
 *                                 contract that the web + client-modules loader
 *                                 fetches and executes (see
 *                                 packages/client/modules + tsdown.client.ts
 *                                 in the DSH checkout).
 *
 * All `@deepseek-ai/*` packages and the React family stay external — they are
 * provided at runtime (host provides @deepseek-ai/*; the browser platform seed
 * provides react / @deepseek-ai/cordis). Node builtins are external under
 * platform 'node'.
 */

import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const outdir = join(root, '..', 'lib')

mkdirSync(outdir, { recursive: true })

// --- node half ---
await build({
  entryPoints: [join(root, '..', 'src', 'index.ts')],
  outfile: join(outdir, 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  // Host-provided runtime deps: resolve from the DSH the plugin is loaded into.
  external: ['@deepseek-ai/*'],
  logLevel: 'info',
})

// --- browser (client) half ---
// Align with the DSH client-modules contract: the bundle is one lazy CJS-ish
// factory handed to window.__ModuleLoader__.load({ id, factory }). The factory
// receives the injected `require` and resolves externals through the platform
// module table (react, @deepseek-ai/cordis), not through the filesystem.
await build({
  entryPoints: [join(root, '..', 'src', 'client', 'index.ts')],
  outfile: join(outdir, 'client.js'),
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2020',
  sourcemap: true,
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  // Platform table provides these at runtime; never bundle them.
  external: [
    'react',
    'react/*',
    'react-dom',
    'react-dom/*',
    '@deepseek-ai/*',
  ],
  banner: {
    js: `window.__ModuleLoader__.load({ id: 'dsh-im-gateway', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;`,
  },
  footer: {
    js: `return module.exports
} })`,
  },
  logLevel: 'info',
})

console.log(`[build.mjs] emitted ${join(outdir, 'index.js')} and ${join(outdir, 'client.js')}`)
