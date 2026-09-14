import crypto from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildApp } from "../src/app.js";
import {
  decodeCursor,
  encodeCursor,
  listHistory,
  parseHistoryQuery,
  HISTORY_DEFAULT_LIMIT,
  HISTORY_MAX_LIMIT,
} from "../src/services/history.service.js";

type Row = {
  id: string;
  senderWalletId: string;
  recipientWalletId: string;
  amountCents: bigint;
  currency: string;
  destinationAmountCents: bigint | null;
  destinationCurrency: string | null;
  fxRate: { toString: () => string } | null;
  status: string;
  createdAt: Date;
  completedAt: Date | null;
};

// Faithful in-memory emulation of the exact findMany contract listHistory
// relies on: wallet OR-filter, composite (createdAt, id) cursor, DESC
// ordering, and take. If the service changes its query shape, these tests
// fail loudly instead of silently passing.
const state = vi.hoisted(() => ({ rows: [] as Row[], lastArgs: null as any }));

function matchesWhere(row: Row, where: any): boolean {
  if (!where) return true;
  if (where.AND) return where.AND.every((w: any) => matchesWhere(row, w));
  if (where.OR) return where.OR.some((w: any) => matchesWhere(row, w));
  for (const [field, cond] of Object.entries(where) as [string, any][]) {
    const value = (row as any)[field];
    if (cond instanceof Date) {
      if (!(value instanceof Date && value.getTime() === cond.getTime()))
        return false;
    } else if (cond && typeof cond === "object") {
      if ("lt" in cond && !(value < cond.lt)) return false;
      if ("equals" in cond) {
        const a = value instanceof Date ? value.getTime() : value;
        const b = cond.equals instanceof Date ? cond.equals.getTime() : cond.equals;
        if (a !== b) return false;
      }
    } else if (value !== cond) return false;
  }
  return true;
}

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    transaction: {
      findMany: async (args: any) => {
        state.lastArgs = args;
        const rows = state.rows.filter((r) => matchesWhere(r, args.where));
        rows.sort((a, b) => {
          const t = b.createdAt.getTime() - a.createdAt.getTime();
          return t !== 0 ? t : b.id < a.id ? -1 : 1;
        });
        return rows.slice(0, args.take);
      },
    },
  },
}));

const WALLET_A = crypto.randomUUID();
const WALLET_B = crypto.randomUUID();
const BASE = Date.UTC(2024, 5, 1, 12, 0, 0);

function row(
  i: number,
  opts: Partial<Row> & { senderWalletId: string },
): Row {
  return {
    id: crypto.randomUUID(),
    recipientWalletId: crypto.randomUUID(),
    amountCents: BigInt(100 + i),
    currency: "USD",
    destinationAmountCents: null,
    destinationCurrency: null,
    fxRate: null,
    status: "COMPLETED",
    createdAt: new Date(BASE + i * 1000),
    completedAt: new Date(BASE + i * 1000),
    ...opts,
  };
}

function seedWallets() {
  // 5 for A (mixed directions), 2 for B, all interleaved in time.
  state.rows = [
    row(0, { senderWalletId: WALLET_A }),
    row(1, { senderWalletId: WALLET_B }),
    row(2, { senderWalletId: crypto.randomUUID(), recipientWalletId: WALLET_A }),
    row(3, { senderWalletId: WALLET_A }),
    row(4, { senderWalletId: WALLET_B }),
    row(5, { senderWalletId: crypto.randomUUID(), recipientWalletId: WALLET_A }),
    row(6, { senderWalletId: WALLET_A }),
  ];
}

beforeEach(() => {
  state.rows = [];
  state.lastArgs = null;
});

async function collectAll(walletId: string, limit: number) {
  const items: any[] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    const parsed: any = parseHistoryQuery({
      walletId,
      limit: String(limit),
      ...(cursor ? { cursor } : {}),
    });
    if ("status" in parsed) throw new Error("unexpected validation error");
    const res = await listHistory(parsed);
    items.push(...res.items);
    pages += 1;
    if (!res.hasMore) {
      expect(res.nextCursor).toBeNull();
      break;
    }
    expect(res.nextCursor).not.toBeNull();
    cursor = res.nextCursor;
    if (pages > 20) throw new Error("pagination did not terminate");
  }
  return items;
}

describe("GET /transactions history", () => {
  it("first page returns the requested count, newest first", async () => {
    seedWallets();
    const res = await listHistory({ walletId: WALLET_A, limit: 2, cursor: null });
    expect(res.items).toHaveLength(2);
    expect(res.hasMore).toBe(true);
    expect(res.nextCursor).not.toBeNull();
    const times = res.items.map((i: any) => i.createdAt);
    expect(times).toEqual([...times].sort().reverse());
  });

  it("default page size applies and take is limit+1", async () => {
    seedWallets();
    const parsed: any = parseHistoryQuery({ walletId: WALLET_A });
    expect(parsed.limit).toBe(HISTORY_DEFAULT_LIMIT);
    await listHistory({ walletId: WALLET_A, limit: parsed.limit, cursor: null });
    expect(state.lastArgs.take).toBe(HISTORY_DEFAULT_LIMIT + 1);
  });

  it("maximum page size is enforced", async () => {
    expect(
      (parseHistoryQuery({ walletId: WALLET_A, limit: "101" }) as any).status,
    ).toBe(400);
    const ok: any = parseHistoryQuery({ walletId: WALLET_A, limit: "100" });
    expect(ok.limit).toBe(100);
    expect(HISTORY_MAX_LIMIT).toBe(100);
  });

  it("paginates the full history with no duplicates and no skips", async () => {
    seedWallets();
    const items = await collectAll(WALLET_A, 2);
    expect(items).toHaveLength(5);
    expect(new Set(items.map((i: any) => i.id)).size).toBe(5);
    // Global DESC order preserved across page boundaries.
    const times = items.map((i: any) => i.createdAt);
    expect(times).toEqual([...times].sort().reverse());
  });

  it("handles identical createdAt values via the id tiebreaker", async () => {
    const same = new Date(BASE);
    state.rows = [0, 1, 2, 3].map(() =>
      row(0, { senderWalletId: WALLET_A, createdAt: same } as any),
    );
    // Distinct ids force tiebreak ordering; all four must surface.
    const items = await collectAll(WALLET_A, 2);
    expect(items).toHaveLength(4);
    expect(new Set(items.map((i: any) => i.id)).size).toBe(4);
  });

  it("exact multiples end cleanly with hasMore false and null cursor", async () => {
    seedWallets();
    const p1 = await listHistory({ walletId: WALLET_A, limit: 5, cursor: null });
    // 5 rows, limit 5: take(6) returns 5 -> no extra row -> last page.
    expect(p1.items).toHaveLength(5);
    expect(p1.hasMore).toBe(false);
    expect(p1.nextCursor).toBeNull();
  });

  it("empty history returns an empty page", async () => {
    const res = await listHistory({
      walletId: crypto.randomUUID(),
      limit: 10,
      cursor: null,
    });
    expect(res).toEqual({ items: [], nextCursor: null, hasMore: false });
  });

  it("never leaks another wallet's transactions", async () => {
    seedWallets();
    const items = await collectAll(WALLET_A, 10);
    for (const item of items as any[]) {
      expect(
        item.senderWalletId === WALLET_A ||
          item.recipientWalletId === WALLET_A,
      ).toBe(true);
      expect(
        item.senderWalletId === WALLET_B &&
          item.recipientWalletId === WALLET_B,
      ).toBe(false);
    }
    // The ownership filter is always part of the query, even with a cursor.
    const p1 = await listHistory({ walletId: WALLET_A, limit: 2, cursor: null });
    await listHistory({
      walletId: WALLET_A,
      limit: 2,
      cursor: decodeCursor(p1.nextCursor!),
    });
    const orClause = JSON.stringify(state.lastArgs.where);
    expect(orClause).toContain(WALLET_A);
  });

  it("a forged cursor for another wallet cannot widen the result set", async () => {
    seedWallets();
    const bPage = await listHistory({ walletId: WALLET_B, limit: 1, cursor: null });
    expect(bPage.nextCursor).not.toBeNull();
    const res = await listHistory({
      walletId: WALLET_A,
      limit: 10,
      cursor: decodeCursor(bPage.nextCursor!),
    });
    for (const item of res.items as any[]) {
      expect(
        item.senderWalletId === WALLET_A ||
          item.recipientWalletId === WALLET_A,
      ).toBe(true);
    }
  });

  it("exposes money fields as strings and omits internals", async () => {
    seedWallets();
    const res = await listHistory({ walletId: WALLET_A, limit: 1, cursor: null });
    const item = res.items[0] as any;
    expect(typeof item.amountCents).toBe("string");
    expect(item).not.toHaveProperty("requestHash");
    expect(item).not.toHaveProperty("failureReason");
    expect(item).not.toHaveProperty("idempotencyKey");
  });

  it("cursor round-trips opaquely", () => {
    const raw = encodeCursor({ createdAt: new Date(BASE).toISOString(), id: "x" });
    expect(raw).not.toContain("createdAt");
    expect(decodeCursor(raw)).toEqual({
      createdAt: new Date(BASE).toISOString(),
      id: "x",
    });
    expect(decodeCursor("!!!not-base64!!!")).toBeNull();
    expect(decodeCursor(Buffer.from("{}").toString("base64url"))).toBeNull();
  });

  it("route rejects malformed cursors, bad limits, and missing walletId", async () => {
    const app = await buildApp();
    const { envVars } = await import("../src/config/env.utils.js");
    envVars.PEER_API_GATEWAY_TOKEN = "test-gateway-token";
    const headers = {
      "x-service-id": "api-gateway",
      "x-service-token": "test-gateway-token",
    };
    for (const query of [
      `/transactions?walletId=${WALLET_A}&cursor=!!!`,
      `/transactions?walletId=${WALLET_A}&cursor=${Buffer.from("{}").toString("base64url")}`,
      `/transactions?walletId=${WALLET_A}&limit=0`,
      `/transactions?walletId=${WALLET_A}&limit=-3`,
      `/transactions?walletId=${WALLET_A}&limit=1.5`,
      `/transactions?walletId=${WALLET_A}&limit=abc`,
      `/transactions?walletId=${WALLET_A}&limit=101`,
      `/transactions?limit=10`,
    ]) {
      const res = await app.inject({ method: "GET", url: query, headers });
      expect(res.statusCode).toBe(400);
    }
  });
});
