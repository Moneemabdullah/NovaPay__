import crypto from "node:crypto";
import { config } from "../config.js";

export const canonical = (x: any): string =>
  Array.isArray(x)
    ? `[${x.map(canonical)}]`
    : x && typeof x === "object"
      ? `{${Object.keys(x)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(x[k])}`)}}`
      : JSON.stringify(x);

export const sha = (x: any) =>
  crypto.createHash("sha256").update(canonical(x)).digest("hex");

export async function post(base: string, path: string, body: any, id?: string) {
  const r = await fetch(base + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": id ?? crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok)
    throw Object.assign(new Error(d.message ?? "Dependency failure"), {
      status: r.status,
      code: d.error,
    });
  return d;
}

export const cents = (amount: bigint, rate: string) =>
  Number((amount * BigInt(rate.replace(".", "").padEnd(9, "0"))) / 100000000n);

export const http = {
  account: config.serviceUrls.account,
  ledger: config.serviceUrls.ledger,
  fx: config.serviceUrls.fx,
};
