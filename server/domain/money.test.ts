import { describe, it, expect } from "vitest";
import { parseGbpToPennies, formatPennies, assertSupportedCurrency, MoneyError } from "./money.ts";

describe("parseGbpToPennies", () => {
  it("parses whole pounds and decimals to integer pennies", () => {
    expect(parseGbpToPennies("60")).toBe(6000);
    expect(parseGbpToPennies("60.00")).toBe(6000);
    expect(parseGbpToPennies("0.01")).toBe(1);
    expect(parseGbpToPennies("180.00")).toBe(18000);
    expect(parseGbpToPennies("45.5")).toBe(4550);
  });

  it("rejects negative amounts", () => {
    expect(() => parseGbpToPennies("-1")).toThrow(MoneyError);
    expect(() => parseGbpToPennies("-0.01")).toThrow(MoneyError);
  });

  it("rejects exponent notation", () => {
    expect(() => parseGbpToPennies("1e2")).toThrow(/exponent/i);
    expect(() => parseGbpToPennies("1E2")).toThrow(/exponent/i);
  });

  it("rejects NaN / non-numeric", () => {
    expect(() => parseGbpToPennies("abc")).toThrow(MoneyError);
    expect(() => parseGbpToPennies("NaN")).toThrow(MoneyError);
    expect(() => parseGbpToPennies("")).toThrow(MoneyError);
    expect(() => parseGbpToPennies("  ")).toThrow(MoneyError);
    expect(() => parseGbpToPennies(60 as unknown)).toThrow(MoneyError);
  });

  it("rejects overprecision (more than 2 decimals)", () => {
    expect(() => parseGbpToPennies("1.234")).toThrow(/decimal/i);
    expect(() => parseGbpToPennies("0.001")).toThrow(/decimal/i);
  });

  it("rejects separators, symbols and padding", () => {
    expect(() => parseGbpToPennies("1,000")).toThrow(MoneyError);
    expect(() => parseGbpToPennies("£60")).toThrow(MoneyError);
    expect(() => parseGbpToPennies(" 60 ")).toThrow(MoneyError);
    expect(() => parseGbpToPennies("+60")).toThrow(MoneyError);
  });

  it("round-trips through formatPennies", () => {
    expect(formatPennies(6000)).toBe("60.00");
    expect(formatPennies(1)).toBe("0.01");
    expect(formatPennies(18000)).toBe("180.00");
  });
});

describe("assertSupportedCurrency", () => {
  it("accepts GBP only", () => {
    expect(assertSupportedCurrency("GBP")).toBe("GBP");
    expect(() => assertSupportedCurrency("USD")).toThrow(MoneyError);
    expect(() => assertSupportedCurrency("")).toThrow(MoneyError);
  });
});
