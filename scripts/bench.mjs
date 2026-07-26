import { performance } from 'node:perf_hooks'
import { Decimal, sum } from '../dist/index.js'

const values = Array.from({ length: 10_000 }, (_, i) => `${i}.${i % 100}`)

function bench(name, iterations, fn) {
  const start = performance.now()
  let last
  for (let i = 0; i < iterations; i++) {
    last = fn(i)
  }
  const elapsedMs = performance.now() - start
  const ops = Math.round((iterations / elapsedMs) * 1000)
  console.log(`${name}: ${ops.toLocaleString('en-US')} ops/sec (${String(last)})`)
}

bench('Decimal.plus', 100_000, (i) =>
  new Decimal(String(i)).plus('0.01').toString(),
)
bench('Decimal.times', 100_000, (i) =>
  new Decimal(String(i)).times('1.075').toString(),
)
bench('Decimal.div', 50_000, (i) =>
  new Decimal(String(i + 1)).div('3', { precision: 8 }).toString(),
)
bench('sum(10k)', 100, () => sum(values).toString())
