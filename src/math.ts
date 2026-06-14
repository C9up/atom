export interface ParsedDecimal {
	int: bigint;
	scale: number;
}

export function parseDecimal(input: string): ParsedDecimal {
	const s = input.trim();
	if (!s) {
		throw new Error("Invalid decimal: empty string");
	}

	let sign = 1n;
	let body = s;
	if (body.startsWith("-")) {
		sign = -1n;
		body = body.slice(1);
	} else if (body.startsWith("+")) {
		body = body.slice(1);
	}

	const parts = body.split(".");
	if (parts.length > 2) {
		throw new Error(`Invalid decimal: ${input}`);
	}
	const whole = parts[0] ?? "";
	const frac = parts[1] ?? "";
	if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) {
		throw new Error(`Invalid decimal: ${input}`);
	}

	const digits = `${whole}${frac}` || "0";
	const int = BigInt(digits) * sign;
	return { int, scale: frac.length };
}

export function formatDecimal(int: bigint, scale: number): string {
	if (scale === 0) return int.toString();

	const negative = int < 0n;
	let s = (negative ? -int : int).toString();
	if (s.length <= scale) {
		s = `${"0".repeat(scale + 1 - s.length)}${s}`;
	}

	const split = s.length - scale;
	const whole = s.slice(0, split);
	let frac = s.slice(split);
	frac = frac.replace(/0+$/, "");

	let out = frac ? `${whole}.${frac}` : whole;
	if (negative && out !== "0") out = `-${out}`;
	return out;
}

/** Exact `10^exp` as a `bigint`. Exported — single definition for the whole TS side. */
export function pow10BigInt(exp: number): bigint {
	let acc = 1n;
	for (let i = 0; i < exp; i++) acc *= 10n;
	return acc;
}
