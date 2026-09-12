import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { consumeQuote } from "../src/services/fx.service.js";

const state = vi.hoisted(() => ({
  rows: [] as any[],
  quote: null as any,
  queryError: null as any,
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    $queryRaw: async () => {
      if (state.queryError) throw state.queryError;
      return state.rows;
    },
    fxQuote: {
      findUnique: async () => {
        if (state.queryError) throw state.queryError;
        return state.quote;
      },
    },
  },
}));

const freshRow = () => ({
  id: "quote-1",
  rate: new Prisma.Decimal("0.92000000"),
  base_currency: "USD",
  quote_currency: "EUR",
});

beforeEach(() => {
  state.rows = [];
  state.quote = null;
  state.queryError = null;
});

describe("consumeQuote", () => {
  it("consumes a valid fresh quote and maps fields to camelCase", async () => {
    state.rows = [freshRow()];
    const res = await consumeQuote("quote-1", "txn-1");
    expect(res.consumed).toBe(true);
    if (res.consumed) {
      expect(res.quote.id).toBe("quote-1");
      expect(res.quote.rate.equals(new Prisma.Decimal("0.92"))).toBe(true);
      expect(res.quote.baseCurrency).toBe("USD");
      expect(res.quote.quoteCurrency).toBe("EUR");
    }
  });

  it("reports an already-consumed quote without consuming (route maps to 409 ALREADY_USED)", async () => {
    state.quote = { id: "quote-1", used: true };
    const res = await consumeQuote("quote-1", "txn-2");
    expect(res.consumed).toBe(false);
    expect(res.quote).toMatchObject({ used: true });
  });

  it("reports an expired quote distinctly from a used one (route maps to 409 EXPIRED)", async () => {
    state.quote = { id: "quote-1", used: false };
    const res = await consumeQuote("quote-1", "txn-3");
    expect(res.consumed).toBe(false);
    expect(res.quote).toMatchObject({ used: false });
  });

  it("reports a missing quote with null (route maps to 404)", async () => {
    const res = await consumeQuote("quote-missing", "txn-4");
    expect(res.consumed).toBe(false);
    expect(res.quote).toBeNull();
  });

  it("second consumption of the same quote does not consume again", async () => {
    state.rows = [freshRow()];
    const first = await consumeQuote("quote-1", "txn-5");
    expect(first.consumed).toBe(true);
    // Atomic UPDATE matched one row exactly once; a repeat finds zero rows
    // and falls back to the now-used quote.
    state.rows = [];
    state.quote = { id: "quote-1", used: true };
    const second = await consumeQuote("quote-1", "txn-6");
    expect(second.consumed).toBe(false);
  });

  it("propagates database failures (e.g. invalid uuid, DB down)", async () => {
    state.queryError = new Error("invalid input syntax for type uuid");
    await expect(consumeQuote("not-a-uuid", "txn-7")).rejects.toThrow(
      "invalid input syntax for type uuid",
    );
  });
});
