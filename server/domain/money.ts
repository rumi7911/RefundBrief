// GBP money handling. All amounts are held as non-negative integer pennies.
// No floating-point arithmetic is ever used for money: parsing is done by
// string inspection so that representation errors cannot creep in.

export class MoneyError extends Error {
  code = "MONEY_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

const DECIMAL_RE = /^(0|[1-9][0-9]{0,9})(?:\.([0-9]{1,2}))?$/;

/**
 * Parse a human-entered GBP amount string into integer pennies.
 * Rejects: empty, negative, NaN, exponent notation, thousands separators,
 * currency symbols, whitespace padding, and more than 2 decimal places
 * (overprecision). Accepts a bare integer or a value with 1-2 decimals.
 */
export function parseGbpToPennies(raw: unknown): number {
  if (typeof raw !== "string") {
    throw new MoneyError("Amount must be a string.");
  }
  const value = raw.trim();
  if (value.length === 0) {
    throw new MoneyError("Amount is required.");
  }
  if (value !== raw) {
    throw new MoneyError("Amount must not contain surrounding whitespace.");
  }
  // Explicitly reject anything that smells like float/exponent/sign tricks
  // before the structural check, to give precise errors.
  if (/[eE]/.test(value)) {
    throw new MoneyError("Exponent notation is not allowed.");
  }
  if (value.startsWith("-") || value.startsWith("+")) {
    throw new MoneyError("Amount must not be signed.");
  }
  const match = DECIMAL_RE.exec(value);
  if (!match) {
    // Distinguish overprecision for a clearer message.
    if (/^\d+\.\d{3,}$/.test(value)) {
      throw new MoneyError("Amount has too many decimal places (max 2).");
    }
    throw new MoneyError("Amount is not a valid GBP value.");
  }
  const whole = match[1];
  const frac = (match[2] ?? "").padEnd(2, "0");
  // String-based assembly — never Number() on the combined decimal.
  const pennies = Number(whole) * 100 + Number(frac);
  if (!Number.isSafeInteger(pennies)) {
    throw new MoneyError("Amount is too large.");
  }
  return pennies;
}

/** Format integer pennies as a GBP decimal string, e.g. 6000 -> "60.00". */
export function formatPennies(pennies: number): string {
  if (!Number.isInteger(pennies) || pennies < 0) {
    throw new MoneyError("Pennies must be a non-negative integer.");
  }
  const whole = Math.floor(pennies / 100);
  const frac = pennies % 100;
  return `${whole}.${String(frac).padStart(2, "0")}`;
}

/** Normalise a currency code; only GBP is supported in this MVP. */
export function assertSupportedCurrency(currency: unknown): "GBP" {
  if (currency !== "GBP") {
    throw new MoneyError("Only GBP is supported.");
  }
  return "GBP";
}
