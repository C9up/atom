// Hand-written stub for the wasm-pack-generated glue file. Lets `tsc --noEmit`
// pass on a fresh checkout before `pnpm build:wasm` has been run. wasm-pack
// will overwrite this file with its real generated declarations on the next
// `build:wasm`; the runtime shape stays compatible.
//
// Story 52.1 review patch (2026-05-09): typecheck was broken on a fresh
// checkout because src/native.ts:60 imports this glue file, and `tsc` could
// not find it without first running `build:wasm`.

export default function init(): Promise<unknown>;

export function add(a: string, b: string): string;
export function sub(a: string, b: string): string;
export function mul(a: string, b: string): string;
export function div(a: string, b: string, precision: number): string;
export function rem(a: string, b: string): string;
export function pow(a: string, exp: number, precision: number): string;
export function sqrt(a: string, precision: number): string;
export function cmp(a: string, b: string): number;
