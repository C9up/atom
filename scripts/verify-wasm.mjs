import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
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
// Hand the binary over as BYTES. Called with no argument, the wasm-bindgen
// `--target web` glue defaults to `new URL('..._bg.wasm', import.meta.url)` and
// fetches it — and Node's fetch refuses a `file:` URL ("not implemented...
// yet..."), so this gate died on the very artifact it was verifying. Bytes skip
// the fetch branch entirely and go straight to WebAssembly.instantiate.
await wasm.default({
  module_or_path: readFileSync(join(wasmDir, 'atom_engine_wasm_bg.wasm')),
})

for (const fn of ['add', 'sub', 'mul', 'div', 'rem', 'pow', 'sqrt', 'cmp',
  'sum', 'dot', 'runBulk']) {
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
// The bulk VM, exercised rather than merely exported: a browser build that
// carries the opcode table but computes something else is the failure this
// gate exists to catch. Quantities 1.50 and 2.25 against prices 10.00 and
// 4.00 — the same program as the engine's own dot-product test.
{
  const values = new BigInt64Array([150n, 225n, 1000n, 400n])
  const program = new Int32Array([
    0, 0, 0, 0, 2, 0, //  LOAD_C  c0 <- column 0, scale 2
    0, 1, 1, 0, 2, 0, //  LOAD_C  c1 <- column 1, scale 2
    23, 0, 0, 1, 0, 0, // DOT_CC  s0 <- c0 . c1
    40, 0, 0, 0, 0, 0, // OUT_S   s0
  ])
  const [total] = wasm.runBulk(values, 2, program)
  if (total !== '24') {
    throw new Error(`[atom:wasm] runBulk smoke test failed: got ${total}, want 24`)
  }
}

if (wasm.sqrt('2', 6) !== '1.414213') {
  throw new Error('[atom:wasm] sqrt smoke test failed')
}
if (wasm.cmp('1.20', '1.2') !== 0) {
  throw new Error('[atom:wasm] cmp smoke test failed')
}

// Present on disk is NOT the same question as present in the package, and it is
// the weaker one. `wasm-pack` writes a `.gitignore` of `*` into its out-dir, and
// npm honours a .gitignore nested inside a published directory even when `files`
// lists that directory — so every check above, smoke tests included, can pass
// while the tarball ships nothing. That is exactly how 0.1.12 went out.
//
// So ask the packer. `--ignore-scripts` keeps this from re-entering
// prepublishOnly, which is what invoked us.
const packed = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: join(here, '..'),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }),
)[0]

const shipped = new Set(packed.files.map((f) => f.path))
for (const name of required) {
  if (!shipped.has(`wasm/${name}`)) {
    throw new Error(
      `[atom:wasm] wasm/${name} is on disk but NOT in the tarball — something is excluding it ` +
        `(a .gitignore or .npmignore nested in wasm/ will do this even though "wasm" is in package.json files). ` +
        `Run \`node scripts/clean-wasm-pack-meta.mjs\` after wasm-pack.`,
    )
  }
}

console.log(`[atom:wasm] browser artifacts present, functional, and in the tarball (${shipped.size} files)`)
