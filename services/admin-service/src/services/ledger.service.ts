import { context, propagation } from "@opentelemetry/api";
import { envVars } from "../config/env.utils.js";

export function checkLedgerInvariant() {
  const headers: Record<string, string> = {};
  propagation.inject(context.active(), headers);
  return fetch(`${envVars.LEDGER_SERVICE_URL}/invariant-check`, { headers });
}

export function verifyAudit() {
  const headers: Record<string, string> = {};
  propagation.inject(context.active(), headers);
  return fetch(`${envVars.LEDGER_SERVICE_URL}/audit/verify`, { headers });
}
