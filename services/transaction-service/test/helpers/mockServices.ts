import http from "node:http";
import type { AddressInfo } from "node:net";

export type LedgerEntryInput = {
  accountId: string;
  direction: "debit" | "credit";
  amountCents: number;
  currency: string;
  fxRate?: string;
};

export type AccountState = {
  balances: Map<string, number>;
  appliedOps: string[];
};

export type LedgerState = {
  batches: Map<
    string,
    { batchId: string; entries: LedgerEntryInput[] }
  >;
  failBatches: boolean;
  failStatus: number;
};

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function startAccountMock() {
  const state: AccountState = { balances: new Map(), appliedOps: [] };
  const server = http.createServer(async (req, res) => {
    const { method, url = "" } = req;
    const gop = url.match(/^\/wallets\/([^/]+)\/operations\/([^/]+)$/);
    if (method === "GET" && gop) {
      const operationKey = decodeURIComponent(gop[2]);
      if (state.appliedOps.includes(operationKey))
        return json(res, 200, {
          walletId: decodeURIComponent(gop[1]),
          operationKey,
          deltaCents: 0,
        });
      return json(res, 404, {
        error: "OPERATION_NOT_FOUND",
        message: "Operation was not found",
      });
    }
    const m = url.match(/^\/wallets\/([^/]+)\/operations$/);
    if (method === "POST" && m) {
      const walletId = decodeURIComponent(m[1]);
      const body = await readBody(req);
      const { operationKey, deltaCents } = body;
      if (!operationKey || !Number.isSafeInteger(deltaCents) || !deltaCents)
        return json(res, 400, {
          error: "VALIDATION_ERROR",
          message: "operationKey and valid deltaCents required",
        });
      if (state.appliedOps.includes(operationKey)) {
        return json(res, 200, {
          id: walletId,
          balanceCents: state.balances.get(walletId) ?? 0,
        });
      }
      const current = state.balances.get(walletId) ?? 0;
      const next = current + deltaCents;
      if (next < 0)
        return json(res, 422, {
          error: "INSUFFICIENT_FUNDS_OR_WALLET_UNAVAILABLE",
          message: "Insufficient available balance or unavailable wallet",
        });
      state.balances.set(walletId, next);
      state.appliedOps.push(operationKey);
      return json(res, 200, { id: walletId, balanceCents: next });
    }
    return json(res, 404, { error: "NOT_FOUND", message: "no such route" });
  });
  const start = () =>
    new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = () => {
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };
  const close = () => new Promise<void>((res) => server.close(() => res()));
  return { state, start, url, close };
}

export function startLedgerMock() {
  const state: LedgerState = {
    batches: new Map(),
    failBatches: false,
    failStatus: 500,
  };
  const server = http.createServer(async (req, res) => {
    const { method, url = "" } = req;
    const m = url.match(/^\/batches\/([^/]+)$/);
    if (method === "GET" && m) {
      const txId = decodeURIComponent(m[1]);
      const batch = state.batches.get(txId);
      if (!batch)
        return json(res, 404, {
          error: "LEDGER_TRANSACTION_NOT_FOUND",
          message: "Ledger transaction not found",
        });
      return json(res, 200, batch);
    }
    if (method === "POST" && url === "/batches") {
      const body = await readBody(req);
      if (state.failBatches)
        return json(res, state.failStatus, {
          error: "LEDGER_UNAVAILABLE",
          message: "ledger unavailable (mock)",
        });
      const batch = {
        batchId: `batch-${body.transactionId}`,
        entries: body.entries ?? [],
      };
      state.batches.set(body.transactionId, batch);
      return json(res, 201, batch);
    }
    return json(res, 404, { error: "NOT_FOUND", message: "no such route" });
  });
  const start = () =>
    new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = () => {
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };
  const close = () => new Promise<void>((res) => server.close(() => res()));
  return { state, start, url, close };
}