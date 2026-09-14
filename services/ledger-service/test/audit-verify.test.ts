import { describe, it, expect, vi, beforeEach } from "vitest";
import { auditVerify, hash } from "../src/services/ledger.service.js";

type Row = {
  id: bigint;
  prevHash: string | null;
  entryHash: string;
  accountId: string;
  direction: string;
  amountCents: bigint;
  currency: string;
  createdAt: Date;
};

// Faithful in-memory ledger_entry table honoring the keyset pagination
// contract auditVerify relies on: id ASC, id > cursor, at most take rows.
const state = vi.hoisted(() => ({ rows: [] as Row[] }));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    ledgerEntry: {
      findMany: async (args: any) => {
        const cursor: bigint | undefined = args?.where?.id?.gt;
        return state.rows
          .filter((r) => cursor === undefined || r.id > cursor)
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .slice(0, args?.take ?? 1000);
      },
    },
  },
}));

function chain(n: number, tamperAt?: number): Row[] {
  const rows: Row[] = [];
  let previous: string | null = null;
  for (let i = 0; i < n; i++) {
    const timestamp = new Date(Date.UTC(2024, 0, 1, 0, 0, i)).toISOString();
    const entry = {
      accountId: `w-${i}`,
      direction: i % 2 ? "credit" : "debit",
      amountCents: 100 + i,
      currency: "USD",
    };
    const entryHash = hash(previous, entry, timestamp);
    rows.push({
      id: BigInt(i + 1),
      prevHash: previous,
      entryHash: i === tamperAt ? "tampered" : entryHash,
      ...entry,
      amountCents: BigInt(entry.amountCents),
      createdAt: new Date(timestamp),
    });
    previous = entryHash;
  }
  return rows;
}

beforeEach(() => {
  state.rows = [];
});

describe("auditVerify batched scan", () => {
  it("checks all records across multiple batches", async () => {
    state.rows = chain(7);
    const res = await auditVerify(3);
    expect(res).toEqual({ ok: true, records: 7 });
  });

  it("handles an empty dataset", async () => {
    expect(await auditVerify(3)).toEqual({ ok: true, records: 0 });
  });

  it("detects tampering in a later batch with the global 1-based index", async () => {
    state.rows = chain(7, 4); // 5th record, second batch of 3
    expect(await auditVerify(3)).toEqual({ ok: false, failedAt: 5 });
  });

  it("detects tampering in the final partial batch", async () => {
    state.rows = chain(7, 6); // 7th record, partial batch of 1
    expect(await auditVerify(3)).toEqual({ ok: false, failedAt: 7 });
  });

  it("verifies hash continuity across batch boundaries", async () => {
    state.rows = chain(5);
    // Corrupt the link: first record of batch 2 points at a wrong prevHash.
    state.rows[3] = { ...state.rows[3], prevHash: "wrong" };
    expect(await auditVerify(3)).toEqual({ ok: false, failedAt: 4 });
  });
});
