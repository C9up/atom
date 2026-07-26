import { defaultQuantizeMode } from "./context.js";
import { Decimal, type DecimalInput, type RoundMode } from "./Decimal.js";

export interface MoneyOptions {
	scale?: number;
	exact?: boolean;
	mode?: RoundMode;
}

export interface MoneyFormatOptions
	extends Omit<Intl.NumberFormatOptions, "style" | "currency"> {
	locale?: Intl.LocalesArgument;
}

const ISO_MINOR_UNITS: Record<string, number> = Object.freeze({
	BHD: 3,
	CLF: 4,
	CLP: 0,
	DJF: 0,
	EUR: 2,
	GBP: 2,
	JPY: 0,
	KMF: 0,
	KRW: 0,
	KWD: 3,
	LYD: 3,
	OMR: 3,
	PYG: 0,
	TND: 3,
	USD: 2,
	VND: 0,
	XAF: 0,
	XOF: 0,
	XPF: 0,
});

export class Money {
	#amount: Decimal;
	#currency: string;
	#scale: number;

	constructor(
		amount: DecimalInput,
		currency: string,
		options: MoneyOptions = {},
	) {
		this.#currency = normalizeCurrency(currency);
		this.#scale = options.scale ?? ISO_MINOR_UNITS[this.#currency] ?? 2;
		const mode = options.mode ?? defaultQuantizeMode();
		const exact = options.exact ?? true;
		const decimal = new Decimal(amount);
		this.#amount = exact
			? Decimal.fromMinorUnits(decimal.toMinorUnits(this.#scale), this.#scale)
			: decimal.toScale(this.#scale, mode);
	}

	static fromMajor(
		amount: DecimalInput,
		currency: string,
		options: MoneyOptions = {},
	): Money {
		return new Money(amount, currency, options);
	}

	static fromMinorUnits(
		minorUnits: string | number | bigint,
		currency: string,
		options: Omit<MoneyOptions, "exact"> = {},
	): Money {
		const normalized = normalizeCurrency(currency);
		const scale = options.scale ?? ISO_MINOR_UNITS[normalized] ?? 2;
		return new Money(Decimal.fromMinorUnits(minorUnits, scale), normalized, {
			...options,
			scale,
			exact: true,
		});
	}

	get amount(): Decimal {
		return this.#amount;
	}

	get currency(): string {
		return this.#currency;
	}

	get scale(): number {
		return this.#scale;
	}

	plus(other: Money): Money {
		this.assertSameCurrency(other);
		return new Money(this.#amount.plus(other.#amount), this.#currency, {
			scale: this.#scale,
		});
	}

	minus(other: Money): Money {
		this.assertSameCurrency(other);
		return new Money(this.#amount.minus(other.#amount), this.#currency, {
			scale: this.#scale,
		});
	}

	times(multiplier: DecimalInput, options: MoneyOptions = {}): Money {
		return new Money(this.#amount.times(multiplier), this.#currency, {
			scale: this.#scale,
			exact: false,
			mode: options.mode,
		});
	}

	div(divisor: DecimalInput, options: MoneyOptions = {}): Money {
		return new Money(this.#amount.div(divisor), this.#currency, {
			scale: this.#scale,
			exact: false,
			mode: options.mode,
		});
	}

	allocate(ratios: Array<string | number | bigint>): Money[] {
		return this.#amount.allocate(ratios).map(
			(part) =>
				new Money(part, this.#currency, {
					scale: this.#scale,
				}),
		);
	}

	toMinorUnits(): bigint {
		return this.#amount.toMinorUnits(this.#scale);
	}

	format(options: MoneyFormatOptions = {}): string {
		const { locale, ...intlOptions } = options;
		return this.#amount.toLocale(locale, {
			style: "currency",
			currency: this.#currency,
			minimumFractionDigits: this.#scale,
			maximumFractionDigits: this.#scale,
			...intlOptions,
		});
	}

	toString(): string {
		return `${this.#amount.toFixed(this.#scale)} ${this.#currency}`;
	}

	toJSON(): { amount: string; currency: string } {
		return {
			amount: this.#amount.toFixed(this.#scale),
			currency: this.#currency,
		};
	}

	private assertSameCurrency(other: Money): void {
		if (this.#currency !== other.#currency || this.#scale !== other.#scale) {
			throw new Error(
				`Currency mismatch: ${this.#currency}/${this.#scale} !== ${other.#currency}/${other.#scale}`,
			);
		}
	}
}

export function money(
	amount: DecimalInput,
	currency: string,
	options: MoneyOptions = {},
): Money {
	return new Money(amount, currency, options);
}

function normalizeCurrency(currency: string): string {
	const normalized = currency.trim().toUpperCase();
	if (!/^[A-Z]{3}$/.test(normalized)) {
		throw new Error(`Invalid currency code: ${currency}`);
	}
	return normalized;
}
