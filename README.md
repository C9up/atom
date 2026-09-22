# @c9up/atom

Exact decimal arithmetic, statistics, and currency-safe money values for the
Ream ecosystem. Rust NAPI/WASM is used when available; the TypeScript BigInt
engine is the fallback.

## Install

```bash
pnpm add @c9up/atom
```

## Decimal

```ts
import { Decimal, decimal, sum } from '@c9up/atom'

decimal('0.1').plus('0.2').toString() // "0.3"
sum(['1.1', '2.2', '3.3']).toString() // "6.6"

Decimal.safeParse('12.34') // { success: true, value: Decimal }
Decimal.tryParse('bad') // null
```

Prefer string or bigint inputs for exact user/business data. Unsafe JS integer
numbers are rejected.

### Batch arithmetic

```ts
Decimal.sum(values)             // Σ vᵢ
Decimal.dot(quantities, prices) // Σ qᵢ·pᵢ — one valuation pass
```

Same digits as folding `plus`/`times`, one crossing of the native boundary
instead of one per operation. The arithmetic was never the cost: each call
serialises its operands, crosses into the engine and returns a string, which
is where a long fold spends its time. Measured on 100 000 values: 132 ms → 47 ms
for a sum, 250 ms → 70 ms for a quantity × price valuation.

`sum`, `avg` and `stddev` already route through it, so existing callers get
this without changing a line.

## Money

```ts
import { money, Money } from '@c9up/atom'

const total = money('10.00', 'USD').allocate([1, 1, 1])
total.map((part) => part.toString()) // ["3.34 USD", "3.33 USD", "3.33 USD"]

Money.fromMinorUnits(1999n, 'EUR').format({ locale: 'fr-FR' })
```

`Money` keeps currency and scale together, and rejects operations across
different currencies. The scale comes from ISO 4217, exceptions included — a
króna stays whole, a dinar keeps its three fils — because `toMinorUnits()` is
what goes into an integer column, where a wrong scale is a factor of a hundred
rather than a rounding difference. Pass `{ scale }` when the column disagrees.

```ts
money('1234', 'ISK').toMinorUnits() // 1234n
money('10.505', 'JOD').toMinorUnits() // 10505n
```

## Context

```ts
import { configureAtomContext, decimal, withAtomContext } from '@c9up/atom'

configureAtomContext({ precision: 8, roundMode: 'trunc' })
withAtomContext({ precision: 2 }, () => decimal('1').div('8').toString())
```

## Bulk

```ts
import { Atom } from '@c9up/atom'

const { net, biggest } = Atom.bulk((b) => {
  const gross = b.column(quantities).times(b.column(prices))
  const total = gross.sum()
  return {
    net: total.minus(total.times(b.of('0.0025'))),
    biggest: gross.max(),
  }
})
```

`Atom.bulk` plans a computation and runs the whole of it in one crossing into
the engine. It is for chains of dependent operations — a schedule, a rate
solver, a statistic over a column — where the cost is the boundary rather than
the arithmetic: a 2 160 step schedule takes 0.30 ms against 2.23 ms through
`Decimal`.

It is not for a lone sum. Below roughly three operations per element a plain
loop over a `BigInt64Array` beats anything that crosses; `pnpm bench:bulk`
prints that comparison next to the others so it stays visible.

A column already held as minor units — the way a money column usually is —
takes the fast lane, at a fourteenth of what the same column costs as decimal
strings:

```ts
const { total } = Atom.bulk((b) => ({
  total: b.minorUnits(rows.map((row) => row.amountCents), 2).sum(),
}))
```

Planned values carry `Decimal`'s method names and refuse to be read until the
plan has been run. Arithmetic is checked against a 128-bit width, and anything
too wide re-runs on the BigInt executor, so the fast path can be too narrow but
never wrong.

## Atlas

```ts
import { Column } from '@c9up/atlas'
import { decimalColumn } from '@c9up/atom/atlas'

class Invoice {
  @Column(decimalColumn({ scale: 2, nullable: false }))
  total!: Decimal
}
```

## Scripts

```bash
pnpm test
pnpm test:napi
pnpm test:coverage
pnpm bench
pnpm bench:bulk
pnpm build:wasm && node scripts/verify-wasm.mjs
```

## Entry points

- `@c9up/atom` — main API
- `@c9up/atom/atlas` — Atlas column helpers

## License

MIT
