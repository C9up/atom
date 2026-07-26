import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

const wasm = await import(pathToFileURL(join(wasmDir, 'atom_engine_wasm.js')).href)
await wasm.default()

for (const fn of ['add', 'sub', 'mul', 'div', 'rem', 'pow', 'sqrt', 'cmp']) {
  if (typeof wasm[fn] !== 'function') {
    throw new Error(`[atom:wasm] invalid exports: missing ${fn}()`)
  }
}

if (wasm.add('1.2', '3.4') !== '4.6') {
  throw new Error('[atom:wasm] add smoke test failed')
}
if (wasm.pow('2', -2, 18) !== '0.25') {
  throw new Error('[atom:wasm] pow smoke test failed')
}
if (wasm.sqrt('2', 6) !== '1.414213') {
  throw new Error('[atom:wasm] sqrt smoke test failed')
}
if (wasm.cmp('1.20', '1.2') !== 0) {
  throw new Error('[atom:wasm] cmp smoke test failed')
}

console.log('[atom:wasm] browser artifacts present and functional')
