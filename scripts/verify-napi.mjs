import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { arch, platform } from 'node:process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const suffixMap = {
  'linux-x64': 'linux-x64-gnu',
  'linux-arm64': 'linux-arm64-gnu',
  'darwin-x64': 'darwin-x64',
  'darwin-arm64': 'darwin-arm64',
  'win32-x64': 'win32-x64-msvc',
}

const suffix = suffixMap[`${platform}-${arch}`]
if (!suffix) {
  throw new Error(`[atom:napi] unsupported platform/arch: ${platform}-${arch}`)
}

const binary = join(root, `index.${suffix}.node`)
if (!existsSync(binary)) {
  throw new Error(`[atom:napi] binary missing: ${binary}`)
}

const require2 = createRequire(import.meta.url)
const binding = require2(binary)

for (const fn of ['add', 'sub', 'mul', 'div', 'rem', 'pow', 'sqrt', 'cmp']) {
  if (typeof binding[fn] !== 'function') {
    throw new Error(`[atom:napi] invalid exports: missing ${fn}()`)
  }
}

if (binding.add('1.2', '3.4') !== '4.6') {
  throw new Error('[atom:napi] add smoke test failed')
}
if (binding.mul('2.5', '2') !== '5') {
  throw new Error('[atom:napi] mul smoke test failed')
}
if (binding.cmp('1.20', '1.2') !== 0) {
  throw new Error('[atom:napi] cmp smoke test failed')
}
if (binding.rem('10.5', '3') !== '1.5') {
  throw new Error('[atom:napi] rem smoke test failed')
}
if (binding.pow('2', -2, 18) !== '0.25') {
  throw new Error('[atom:napi] pow smoke test failed')
}
if (binding.sqrt('2', 6) !== '1.414213') {
  throw new Error('[atom:napi] sqrt smoke test failed')
}

console.log('[atom:napi] smoke test passed')
