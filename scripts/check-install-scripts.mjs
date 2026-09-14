#!/usr/bin/env node
/**
 * Guard: the plugin's *runtime* dependency closure must stay free of packages
 * that run an install-time script (`preinstall` / `install` / `postinstall`).
 *
 * WHY THIS EXISTS: pnpm >= 10 never runs an unapproved dependency build script;
 * it reports `ERR_PNPM_IGNORED_BUILDS` and exits non-zero, and `dsh plugin`
 * treats that as a failed install — printing a hint that tells the user to
 * hand-edit the profile's `pnpm-workspace.yaml`. One transitive `postinstall`
 * anywhere in the closure therefore breaks "just install it" for every user on
 * every machine. (The Feishu SDK used to drag in exactly that: `protobufjs`.)
 *
 * The scan is deliberately resolution-based rather than lockfile-based: it
 * follows `dependencies` + `optionalDependencies` the way Node resolves them
 * from the installed tree, so it works under pnpm's hoisted, isolated, and
 * nested layouts alike. Peer dependencies are skipped — the consumer does not
 * install them (they come from the DSH host).
 *
 * Run standalone (`pnpm check:deps`) or as the tail of `pnpm build`.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, parse, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall']
const BUILTINS = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)])

/** Read and parse a JSON file. */
const readJson = file => JSON.parse(readFileSync(file, 'utf8'))

/** A dependency spec's package name (`protobufjs/minimal` -> `protobufjs`). */
function packageNameOf(spec) {
  return spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
}

/**
 * Resolve a package the way Node does, walking `node_modules` upward from the
 * depending package — this is what makes the scan layout-agnostic. The result
 * is a realpath, because pnpm's isolated layout links a package to
 * `.pnpm/<name>@<version>/node_modules/<name>` and materializes its
 * dependencies as *siblings there*, not under the symlinked path.
 * @returns the package directory, or null when it is not installed (optional /
 * unmet peer dependency).
 */
function resolvePackageDir(name, fromDir) {
  let dir = fromDir
  for (;;) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
    const parent = dirname(dir)
    if (parent === dir || parse(dir).root === dir) return null
    dir = parent
  }
}

const visited = new Set()
const offenders = []
const chains = new Map()

/**
 * Walk one package's runtime closure.
 * @param spec - the dependency spec that pulled this package in.
 * @param fromDir - the directory of the package that declared it.
 * @param chain - package names from the root to the declarer (for reporting).
 */
function visit(spec, fromDir, chain) {
  const name = packageNameOf(spec)
  if (BUILTINS.has(spec) || BUILTINS.has(name)) return
  const dir = resolvePackageDir(name, fromDir)
  if (dir === null) return
  if (visited.has(dir)) return
  visited.add(dir)
  const manifest = readJson(join(dir, 'package.json'))
  const scripts = manifest.scripts ?? {}
  const found = INSTALL_SCRIPTS.filter(script => typeof scripts[script] === 'string')
  if (found.length > 0) {
    const key = `${manifest.name}@${manifest.version}`
    offenders.push({ key, scripts: found.map(script => `${script}: ${scripts[script]}`) })
    chains.set(key, chain.slice(-3))
  }
  const declared = manifest.dependencies ?? {}
  const optional = manifest.optionalDependencies ?? {}
  for (const dep of [...Object.keys(declared), ...Object.keys(optional)]) {
    visit(dep, dir, [...chain, manifest.name])
  }
}

const manifest = readJson(join(root, 'package.json'))
const entries = [
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.optionalDependencies ?? {}),
]
for (const entry of entries) visit(entry, root, [])

if (offenders.length === 0) {
  console.log(`\u2714 runtime dependencies: ${visited.size} packages scanned, no install-time scripts`)
  console.log('  (pnpm will not ask for an allowBuilds entry, on any machine)')
  process.exit(0)
}

console.error(`\u2716 install-time scripts found in the runtime dependency closure (${visited.size} packages scanned):`)
for (const offender of offenders) {
  const chain = chains.get(offender.key) ?? []
  console.error(`  ${offender.key}  via ${chain.join(' > ') || '<direct dependency>'}`)
  for (const script of offender.scripts) console.error(`      ${script}`)
}
console.error('')
console.error('A transitive install script makes `dsh plugin add <git-url>` fail on a clean profile:')
console.error('pnpm exits with ERR_PNPM_IGNORED_BUILDS and the user is told to hand-edit the')
console.error("profile's pnpm-workspace.yaml. Remove the dependency, swap it for one without")
console.error('install scripts, or vendor the package into lib/ (see scripts/build.mjs).')
process.exit(1)
