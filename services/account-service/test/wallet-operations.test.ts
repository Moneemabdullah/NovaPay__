import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildApp } from "../src/app.js";
import { applyWalletOperation } from "../src/services/wallet.service.js";

const state = vi.hoisted(() => ({ tx: null as any }));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    $transaction: (fn: any) => fn(state.tx),
  },
}));

function makeTx() {
  return {
    walletBalanceOperation: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async (args: any) => args.data),
    },
    wallet: {
      findUnique: vi.fn(async () => null),
    },
    $executeRaw: vi.fn(async () => 1),
  };
}

const walletRow = (balanceCents: bigint, version: bigint) => ({
  id: "wallet-1",
  userId: "user-1",
  currency: "USD",
  balanceCents,
  version,
  status: "active",
});

beforeEach(() => {
  state.tx = makeTx();
});

describe("applyWalletOperation", () => {
  it("applies a credit and returns the updated wallet", async () => {
    state.tx.wallet.findUnique.mockResolvedValueOnce(walletRow(1500n, 4n));
    const res = await applyWalletOperation({
      walletId: "wallet-1",
      operationKey: "op-1",
      deltaCents: 500,
    });
    expect(state.tx.$executeRaw).toHaveBeenCalledOnce();
    expect(state.tx.walletBalanceOperation.create).toHaveBeenCalledOnce();
    expect(res).toMatchObject({ balanceCents: "1500", version: "4" });
  });

  it("applies a debit when the balance covers it", async () => {
    state.tx.wallet.findUnique.mockResolvedValueOnce(walletRow(700n, 5n));
    const res = await applyWalletOperation({
      walletId: "wallet-1",
      operationKey: "op-2",
      deltaCents: -300,
    });
    expect(state.tx.walletBalanceOperation.create).toHaveBeenCalledOnce();
    expect(res).toMatchObject({ balanceCents: "700", version: "5" });
  });

  it("returns null and records nothing on insufficient balance", async () => {
    state.tx.$executeRaw.mockResolvedValueOnce(0);
    const res = await applyWalletOperation({
      walletId: "wallet-1",
      operationKey: "op-3",
      deltaCents: -999999,
    });
    expect(res).toBeNull();
    expect(state.tx.walletBalanceOperation.create).not.toHaveBeenCalled();
  });

  it("returns null for a missing or inactive wallet", async () => {
    state.tx.$executeRaw.mockResolvedValueOnce(0);
    const res = await applyWalletOperation({
      walletId: "nope",
      operationKey: "op-4",
      deltaCents: 100,
    });
    expect(res).toBeNull();
    expect(state.tx.walletBalanceOperation.create).not.toHaveBeenCalled();
  });

  it("replays idempotently: existing operation returns the wallet without a second update", async () => {
    state.tx.walletBalanceOperation.findUnique.mockResolvedValueOnce({
      walletId: "wallet-1",
      operationKey: "op-1",
    });
    state.tx.wallet.findUnique.mockResolvedValueOnce(walletRow(1500n, 4n));
    const res = await applyWalletOperation({
      walletId: "wallet-1",
      operationKey: "op-1",
      deltaCents: 500,
    });
    expect(state.tx.$executeRaw).not.toHaveBeenCalled();
    expect(state.tx.walletBalanceOperation.create).not.toHaveBeenCalled();
    expect(res).toMatchObject({ balanceCents: "1500" });
  });

  it("replay returns null when the wallet is gone", async () => {
    state.tx.walletBalanceOperation.findUnique.mockResolvedValueOnce({
      walletId: "wallet-1",
      operationKey: "op-1",
    });
    state.tx.wallet.findUnique.mockResolvedValueOnce(null);
    const res = await applyWalletOperation({
      walletId: "wallet-1",
      operationKey: "op-1",
      deltaCents: 500,
    });
    expect(res).toBeNull();
  });

  it("propagates database failures instead of swallowing them", async () => {
    state.tx.walletBalanceOperation.findUnique.mockRejectedValueOnce(
      new Error("db down"),
    );
    await expect(
      applyWalletOperation({
        walletId: "wallet-1",
        operationKey: "op-5",
        deltaCents: 100,
      }),
    ).rejects.toThrow("db down");
  });

  it("rejects non-integer amounts at the service backstop", async () => {
    await expect(
      applyWalletOperation({
        walletId: "wallet-1",
        operationKey: "op-6",
        deltaCents: 10.5,
      }),
    ).rejects.toThrow();
    expect(state.tx.walletBalanceOperation.create).not.toHaveBeenCalled();
  });
});

describe("POST /wallets/:walletId/operations validation", () => {
  it("rejects non-integer, zero, or missing deltaCents with 400", async () => {
    const app = await buildApp();
    for (const body of [
      { operationKey: "k", deltaCents: 10.5 },
      { operationKey: "k", deltaCents: 0 },
      { operationKey: "k" },
      { deltaCents: 100 },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/wallets/wallet-1/operations",
        payload: body,
      });
      expect(res.statusCode).toBe(400);
    }
  });
});
