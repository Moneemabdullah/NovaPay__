import crypto from "node:crypto";
import { context, propagation } from "@opentelemetry/api";
import { envVars } from "../config/env.utils.js";

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
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-request-id": id ?? crypto.randomUUID(),
  };
  propagation.inject(context.active(), headers);
  const r = await fetch(base + path, {
    method: "POST",
    headers,
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

export async function get(base: string, path: string, id?: string) {
  const headers: Record<string, string> = {
    "x-request-id": id ?? crypto.randomUUID(),
  };
  propagation.inject(context.active(), headers);
  const r = await fetch(base + path, { headers });
  if (r.status === 404) return null;
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
  account: envVars.ACCOUNT_SERVICE_URL,
  ledger: envVars.LEDGER_SERVICE_URL,
  fx: envVars.FX_SERVICE_URL,
};
