import { envVars } from "../config/env.utils.js";

export function checkLedgerInvariant() {
  return fetch(`${envVars.LEDGER_SERVICE_URL}/invariant-check`);
}

export function verifyAudit() {
  return fetch(`${envVars.LEDGER_SERVICE_URL}/audit/verify`);
}
