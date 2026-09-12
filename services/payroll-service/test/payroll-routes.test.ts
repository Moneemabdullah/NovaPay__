import { describe, it, expect } from "vitest";
import { buildApp } from "../src/app.js";
import { MAX_PAYROLL_ITEMS } from "../src/routes/payroll.routes.js";

const item = (i: number) => ({
  recipientWalletId: `wallet-${i}`,
  amountCents: 100 + i,
});

describe("POST /jobs batch-size validation", () => {
  it("rejects batches over MAX_PAYROLL_ITEMS with 400 before touching the DB", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: {
        employerAccountId: "emp-1",
        items: Array.from({ length: MAX_PAYROLL_ITEMS + 1 }, (_, i) =>
          item(i),
        ),
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("VALIDATION_ERROR");
  });

  it("keeps existing validation: missing employer and empty items are 400", async () => {
    const app = await buildApp();
    const noEmployer = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: { items: [item(0)] },
    });
    expect(noEmployer.statusCode).toBe(400);
    const empty = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: { employerAccountId: "emp-1", items: [] },
    });
    expect(empty.statusCode).toBe(400);
  });
});
