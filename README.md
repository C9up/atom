# @c9up/atom

> Exact decimal arithmetic + statistics for the Ream ecosystem (TypeScript + Rust N-API). No floating-point drift.

Part of **[Ream](https://github.com/C9up/ream)** — a Rust-powered, AdonisJS-compatible Node.js framework. Independent, publishable package.

## Installation

```bash
pnpm add @c9up/atom
```

## Usage

```ts
import { decimal, sum, avg, median, stddev } from '@c9up/atom'

const price = decimal('19.99')          // exact decimal, no float drift
sum(['1.1', '2.2', '3.3'])              // exact aggregate
avg(values); median(values); stddev(values)
```

## Entry points

- `@c9up/atom` — main API
- `@c9up/atom/atlas` — Atlas integration adapter

## License

MIT
