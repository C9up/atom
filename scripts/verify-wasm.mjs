import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Publish-time gate: the `wasm-pack build --target web` output (JS glue + the
// binary) MUST be in the package. Without it the browser loader
// (src/native.ts) throws ATOM_ENGINE_NOT_FOUND at runtime — exactly the
// "stub-only tarball" failure this gate exists to prevent. Only the hand-written
// `atom_engine_wasm.d.ts` typecheck stub is committed; the .js/.wasm are built.

const here = dirname(fileURLToPath(import.meta.url))
const wasmDir = join(here, '..', 'wasm')

const required = ['atom_engine_wasm.js', 'atom_engine_wasm_bg.wasm']
for (const name of required) {
  const p = join(wasmDir, name)
  if (!existsSync(p)) {
    throw new Error(
      `[atom:wasm] missing build artifact: wasm/${name} — run \`pnpm build:wasm\` (wasm-pack) before publishing`,
    )
  }
  if (statSync(p).size === 0) {
    throw new Error(`[atom:wasm] empty build artifact: wasm/${name}`)
  }
}

console.log('[atom:wasm] browser artifacts present')
