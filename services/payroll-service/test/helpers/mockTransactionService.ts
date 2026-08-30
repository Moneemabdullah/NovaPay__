import http from "node:http";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";

export type TxMockState = {
  attempts: string[];
  txByKey: Map<string, string>;
  failKey: string | null;
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

// Faithful stand-in for the transaction-service idempotency gate: the same
// idempotency key, resubmitted, replays the stored transactionId instead of
// moving money again.
export function startTransactionMock() {
  const state: TxMockState = { attempts: [], txByKey: new Map(), failKey: null };
  const server = http.createServer(async (req, res) => {
    const { method, url = "" } = req;
    if (method === "POST" && url === "/transactions") {
      const key = String(req.headers["idempotency-key"] ?? "");
      await readBody(req);
      state.attempts.push(key);
      if (state.failKey === key)
        return json(res, 500, {
          error: "TRANSACTION_FAILED",
          message: "transaction failed (mock crash point)",
        });
      const existing = state.txByKey.get(key);
      if (existing) return json(res, 200, { transactionId: existing });
      const transactionId = crypto.randomUUID();
      state.txByKey.set(key, transactionId);
      return json(res, 201, { transactionId });
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