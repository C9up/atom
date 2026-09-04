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
pnpm build:wasm && node scripts/verify-wasm.mjs
```

## Entry points

- `@c9up/atom` — main API
- `@c9up/atom/atlas` — Atlas column helpers

## License

MIT
