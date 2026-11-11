#!/usr/bin/env node
/**
 * Build the browser engine: `wasm/atom_engine_wasm.js` + `_bg.wasm`.
 *
 * Two pinned steps and nothing fetched. Cargo builds the wasm32 crate from
 * `Cargo.lock`; then the `wasm-bindgen` CLI writes the `--target web` glue.
 * The CLI has to be the exact version of the `wasm-bindgen` crate in
 * `Cargo.lock` — the two speak a schema that changes between releases — so it
 * is checked before anything is built, and a mismatch is refused with the
 * install command rather than worked around.
 *
 * This replaces `wasm-pack build`, which did the same two steps but fetched
 * the `wasm-bindgen` CLI and a binaryen `wasm-opt` from GitHub releases at
 * build time, with no digest, in the job that publishes. The binary is not
 * run through `wasm-opt`: the release profile already builds it with fat LTO
 * at opt-level 3, and a rewriter nobody pins is not worth the bytes it saves.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { env } from 'node:process'
import { fileURLToPath } from 'node:url'

const TAG = '[atom:wasm]'
const CRATE = 'atom-engine-wasm'
const TARGET = 'wasm32-unknown-unknown'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The version `Cargo.lock` resolves a registry package to. */
function lockedVersion(name) {
  const lock = readFileSync(join(root, 'Cargo.lock'), 'utf8')
  const versions = lock
    .split('[[package]]')
    .map((block) => ({
      name: /^name = "([^"]+)"$/m.exec(block)?.[1],
      version: /^version = "([^"]+)"$/m.exec(block)?.[1],
    }))
    .filter((entry) => entry.name === name && entry.version !== undefined)
    .map((entry) => entry.version)
  if (versions.length !== 1) {
    throw new Error(
      `${TAG} expected exactly one ${name} in Cargo.lock, found ${versions.length}`,
    )
  }
  return versions[0]
}

const wanted = lockedVersion('wasm-bindgen')

let installed
try {
  installed = execFileSync('wasm-bindgen', ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
} catch {
  installed = 'none'
}
if (installed !== `wasm-bindgen ${wanted}`) {
  throw new Error(
    `${TAG} the wasm-bindgen CLI must match Cargo.lock's wasm-bindgen ${wanted} (found: ${installed}).\n` +
      `  Install it with: cargo install wasm-bindgen-cli --locked --version ${wanted}`,
  )
}

execFileSync(
  'cargo',
  ['build', '--locked', '--release', '--target', TARGET, '-p', CRATE],
  { cwd: root, stdio: 'inherit' },
)

// Cargo writes under CARGO_TARGET_DIR when it is set, resolved against the
// directory it ran in — this package root.
const targetDir = env.CARGO_TARGET_DIR
  ? resolve(root, env.CARGO_TARGET_DIR)
  : join(root, 'target')
const binary = join(targetDir, TARGET, 'release', `${CRATE.replaceAll('-', '_')}.wasm`)

execFileSync(
  'wasm-bindgen',
  ['--target', 'web', '--out-dir', join(root, 'wasm'), binary],
  { cwd: root, stdio: 'inherit' },
)

console.log(`${TAG} built wasm/ with wasm-bindgen ${wanted}`)
