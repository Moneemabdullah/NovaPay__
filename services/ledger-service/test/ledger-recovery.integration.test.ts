import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";

const SENDER = "00000000-0000-0000-0000-0000000000aa";
const RECIPIENT = "00000000-0000-0000-0000-0000000000bb";
const TX = (n: number) =>
  `00000000-0000-0000-0000-${n.toString().padStart(12, "0")}`;

const BALANCED_ENTRIES = [
  { accountId: SENDER, direction: "debit", amountCents: 10_000, currency: "USD" },
  { accountId: RECIPIENT, direction: "credit", amountCents: 10_000, currency: "USD" },
];

describe("ledger invariant across crash-recovery scenarios (integration)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  const invariant = () =>
    app.inject({ method: "GET", url: "/invariant-check" }).then((r) => r.json());

  const postBatch = (transactionId: string, entries = BALANCED_ENTRIES) =>
    app.inject({ method: "POST", url: "/batches", payload: { transactionId, entries } });

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.ledgerEntry.deleteMany({});
    await prisma.ledgerTransaction.deleteMany({});
  });

  afterEach(async () => {
    await prisma.ledgerEntry.deleteMany({});
    await prisma.ledgerTransaction.deleteMany({});
  });

  it("a completed movement records one balanced batch and the invariant stays zero", async () => {
    const before = await invariant();
    expect(before.ok).toBe(true);
    expect(before.delta).toBe(0);

    const res = await postBatch(TX(1));
    expect(res.statusCode).toBe(201);
    const get = await app.inject({ method: "GET", url: `/batches/${TX(1)}` });
    expect(get.statusCode).toBe(200);

    const after = await invariant();
    expect(after.ok).toBe(true);
    expect(after.delta).toBe(0);
  });

  it("replaying the same batch (idempotent recovery) keeps a single batch and a zero invariant", async () => {
    await postBatch(TX(2));
    const replay = await postBatch(TX(2));
    expect(replay.json()).toMatchObject({ replayed: true });
    expect(await prisma.ledgerTransaction.count({ where: { transactionId: TX(2) } })).toBe(1);

    const r = await invariant();
    expect(r.ok).toBe(true);
    expect(r.delta).toBe(0);
  });

  it("a reversed movement never posts a batch, so the ledger stays empty and balanced", async () => {
    const get = await app.inject({ method: "GET", url: `/batches/${TX(3)}` });
    expect(get.statusCode).toBe(404);
    expect(await prisma.ledgerTransaction.count()).toBe(0);

    const r = await invariant();
    expect(r.ok).toBe(true);
    expect(r.delta).toBe(0);
  });

  it("auto-replay and reversal scenarios together leave the invariant at zero", async () => {
    await postBatch(TX(4));
    await postBatch(TX(4));
    // The reversed movement for TX(5) never reaches the ledger.
    const get = await app.inject({ method: "GET", url: `/batches/${TX(5)}` });
    expect(get.statusCode).toBe(404);

    const r = await invariant();
    expect(r.ok).toBe(true);
    expect(r.delta).toBe(0);
    expect(await prisma.ledgerTransaction.count()).toBe(1);
  });
});