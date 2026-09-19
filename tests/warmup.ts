/**
 * Pay the cold-start costs before the clock starts.
 *
 * Three tests failed on `win32-x64-msvc` only — and only ever with
 * "Test timed out in 5000ms", never an assertion. They are trivial
 * (`money("19.99", "USD")`, `Decimal.parseLocale("1 234,56", "fr-FR")`) and
 * cannot spend five seconds computing, so the time goes somewhere before the
 * work: loading the NAPI binary, and building ICU data for the first
 * `Intl.NumberFormat` in the process.
 *
 * Both are per-WORKER costs, which is why the three failures were in three
 * different files: vitest runs each file in its own worker, so each one paid
 * them again. Measured on Linux, the first `Intl.NumberFormat` costs ~24 ms
 * against ~0.05 ms warm — a 500x gap that a cold Windows runner with contended
 * I/O stretches much further.
 *
 * Doing it here charges the cost to the setup hook instead of to a test's
 * budget, and does it once per worker rather than once per file that happens
 * to touch it first.
 */

import { Decimal, money } from "../src/index.js";

// Loads the native engine.
void money("1.00", "USD");
// Builds the ICU data both the currency scale lookup and `parseLocale` need.
void new Intl.NumberFormat("fr-FR").formatToParts(1234.56);
void Decimal.parseLocale("1 234,56", "fr-FR");
