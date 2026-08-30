import { config } from "../config.js";

export function checkLedgerInvariant() {
  return fetch(`${config.ledgerServiceUrl}/invariant-check`);
}

export function verifyAudit() {
  return fetch(`${config.ledgerServiceUrl}/audit/verify`);
}
