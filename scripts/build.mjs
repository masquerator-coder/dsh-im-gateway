#!/usr/bin/env node
/**
 * esbuild build for dsh-im-gateway: bundle `src/index.ts` into `lib/index.js`.
 *
 * All `@deepseek-ai/*` packages are left external — they are optional peer
 * dependencies provided by the host DSH runtime at load time, never bundled.
 * Node builtins are external automatically under `platform: 'node'`.
 */

import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const entry = join(root, '..', 'src', 'index.ts')
const outfile = join(root, '..', 'lib', 'index.js')

mkdirSync(dirname(outfile), { recursive: true })

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  // Host-provided runtime deps: resolve from the DSH the plugin is loaded into.
  external: ['@deepseek-ai/*'],
  logLevel: 'info',
})

console.log(`[build.mjs] emitted ${outfile}`)
