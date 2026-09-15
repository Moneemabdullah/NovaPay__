import { context, propagation } from "@opentelemetry/api";
import { envVars } from "../config/env.utils.js";

function serviceIdentity(): Record<string, string> {
  return {
    "x-service-id": envVars.SERVICE_ID,
    "x-service-token": envVars.SERVICE_TOKEN,
  };
}

export function checkLedgerInvariant() {
  const headers: Record<string, string> = { ...serviceIdentity() };
  propagation.inject(context.active(), headers);
  return fetch(`${envVars.LEDGER_SERVICE_URL}/invariant-check`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
}

export function verifyAudit() {
  const headers: Record<string, string> = { ...serviceIdentity() };
  propagation.inject(context.active(), headers);
  return fetch(`${envVars.LEDGER_SERVICE_URL}/audit/verify`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
}
