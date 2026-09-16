import { existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Removes the package metadata `wasm-pack` writes into its output directory.
//
// `wasm-pack build` treats its out-dir as a publishable package of its own and
// scaffolds one: a `package.json`, and a `.gitignore` whose entire content is
// `*`. Ours is not a package — it is a directory inside this one, listed in
// `files`.
//
// The `.gitignore` is the damaging half. npm honours a .gitignore nested INSIDE
// a published directory even when `files` lists that directory, so a single `*`
// silently strips every artifact from the tarball — the built .js and .wasm, and
// the committed .d.ts stub with them. The package then publishes green and every
// browser consumer gets the engine-missing error. Measured here: with the file
// present `npm pack --dry-run` reports zero wasm/ entries, without it, two.
//
// Runs right after wasm-pack, before anything packs.

const wasmDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'wasm')

// Only what wasm-pack scaffolds. The artifacts and the committed .d.ts stay.
const generated = ['.gitignore', 'package.json', 'README.md', 'LICENSE']

for (const name of generated) {
  const path = join(wasmDir, name)
  if (existsSync(path)) {
    rmSync(path)
    console.log(`[wasm] removed generated wasm/${name}`)
  }
}
