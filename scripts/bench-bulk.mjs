// What bulk is for, and what it is not for — the measurements that decided the
// design, kept runnable so a change that undoes them is visible.
//
//   pnpm bench:bulk [rows]
import { performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'
import { Atom, Bulk, Decimal, isNativeAvailable, sum } from '../dist/index.js'

const native = createRequire(import.meta.url)('../index.linux-x64-gnu.node')
const ROWS = Number(process.argv[2] ?? 200_000)

const time = (label, runs, fn) => {
  fn()
  const start = performance.now()
  for (let i = 0; i < runs; i++) fn()
  const ms = (performance.now() - start) / runs
  console.log(`  ${label.padEnd(42)} ${ms.toFixed(3).padStart(10)} ms`)
  return ms
}

console.log(`native engine: ${isNativeAvailable()}`)

// --- 1. the crossing itself -------------------------------------------------
// A typed array crosses as a pointer, so the cost must not follow the size.
console.log('\n1. Crossing cost against buffer size')
const noop = Int32Array.from([1, 0, 0, 0, 0, 0, 40, 0, 0, 0, 0, 0])
for (const size of [1_000, 1_000_000, 10_000_000]) {
  const buffer = new BigInt64Array(size).fill(1n)
  time(`runBulk over ${size.toLocaleString('en-US')} values`, 200, () =>
    native.runBulk(buffer, 1, noop),
  )
}

// --- 2. a chain of dependent operations -------------------------------------
// The shape bulk exists for: a schedule, where every step reads the last.
console.log('\n2. A 2160-step schedule (360 rows x 6 operations)')
const STEPS = 2160
const viaBulk = time(`bulk   ${STEPS} operations, one crossing`, 100, () => {
  const plan = new Bulk()
  let running = plan.of('1000.00')
  const payment = plan.of('12.50')
  for (let i = 0; i < STEPS; i++) running = running.plus(payment)
  return plan.run({ balance: running })
})
const viaCalls = time(`napi   ${STEPS} operations, ${STEPS} crossings`, 100, () => {
  let x = '1000.00'
  for (let i = 0; i < STEPS; i++) x = native.add(x, '12.50')
  return x
})
const viaDecimal = time(`Decimal ${STEPS} operations`, 100, () => {
  let x = new Decimal('1000.00')
  for (let i = 0; i < STEPS; i++) x = x.plus('12.50')
  return x
})
console.log(`  -> against one call per operation : ${(viaCalls / viaBulk).toFixed(0)}x`)
console.log(`  -> against Decimal               : ${(viaDecimal / viaBulk).toFixed(0)}x`)

// --- 3. a column reduction --------------------------------------------------
// The shape bulk is NOT for: one operation per element, where a plain loop wins
// and crossing at all is the mistake. Kept here so that stays visible.
console.log(`\n3. A column reduction over ${ROWS.toLocaleString('en-US')} values`)
const quantities = Array.from({ length: ROWS }, (_, i) => `${(i % 1000) + 1}.0000`)
const prices = Array.from({ length: ROWS }, (_, i) => `10.${String((i % 97) * 100).padStart(4, '0')}`)
const minor = new BigInt64Array(2 * ROWS)
for (let i = 0; i < ROWS; i++) {
  minor[i] = BigInt(((i % 1000) + 1) * 10_000)
  minor[ROWS + i] = BigInt(100_000 + (i % 97) * 100)
}

const bulkDot = time('bulk    column.dot(column)', 10, () =>
  Atom.bulk((b) => ({ total: b.column(quantities).dot(b.column(prices)) })),
)
const decimalDot = time('Decimal.dot (strings)', 10, () => Decimal.dot(quantities, prices))
const publicSum = time('sum() over one column', 10, () => sum(quantities))
const plainJs = time('a plain for over a BigInt64Array', 10, () => {
  let total = 0n
  for (let i = 0; i < ROWS; i++) total += minor[i] * minor[ROWS + i]
  return total
})
console.log(`  -> bulk against Decimal.dot : ${(decimalDot / bulkDot).toFixed(1)}x`)
console.log(`  -> bulk against a plain loop: ${(plainJs / bulkDot).toFixed(2)}x  <- below 1 means do not cross`)
console.log(`  (sum() shown for scale: ${publicSum.toFixed(1)} ms)`)

// --- 4. taking the data in ---------------------------------------------------
// Where the time actually goes once the engine is cheap: turning what the
// database handed over into integers. A column already held as minor units
// skips all of it.
console.log(`\n4. Taking ${ROWS.toLocaleString('en-US')} values into a plan`)
const cents = quantities.map((value) => BigInt(Math.round(Number(value) * 10_000)))
const asStrings = time('column(decimal strings)', 10, () => {
  const plan = new Bulk()
  return plan.run({ total: plan.column(quantities).sum() })
})
const asMinor = time('minorUnits(bigints, 4)', 10, () => {
  const plan = new Bulk()
  return plan.run({ total: plan.minorUnits(cents, 4).sum() })
})
console.log(`  -> minor units against decimal strings: ${(asStrings / asMinor).toFixed(1)}x`)
