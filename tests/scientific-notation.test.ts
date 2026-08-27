import { describe, expect, it } from 'vitest'
import { Decimal } from '../src/Decimal.js'

describe('scientific notation', () => {
  it('accepts the string form the same way as the number form', () => {
    expect(new Decimal('1E-10').toString()).toBe(new Decimal(1e-10).toString())
    expect(new Decimal('1E-10').toString()).toBe('0.0000000001')
  })
  it('handles sign, exponent sign and a fractional coefficient', () => {
    expect(new Decimal('-1.5e3').toString()).toBe('-1500')
    expect(new Decimal('2.5E+2').toString()).toBe('250')
    expect(new Decimal('1e0').toString()).toBe('1')
  })
  it('keeps arithmetic exact through the expansion', () => {
    expect(new Decimal('1E-10').plus('1E-10').toString()).toBe('0.0000000002')
  })
  it('refuses a pathological exponent instead of expanding it', () => {
    expect(() => new Decimal('1E1000000')).toThrow(/Invalid decimal/)
  })
  it('still refuses genuine garbage', () => {
    expect(() => new Decimal('1E')).toThrow(/Invalid decimal/)
    expect(() => new Decimal('E5')).toThrow(/Invalid decimal/)
    expect(() => new Decimal('1e1.5')).toThrow(/Invalid decimal/)
  })
  it('allocate splits money without losing a cent', () => {
    expect(new Decimal('10.00').allocate([1, 1, 1]).map(String)).toEqual(['3.34', '3.33', '3.33'])
  })
})
