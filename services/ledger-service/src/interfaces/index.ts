export interface LedgerEntryInput {
  accountId: string;
  direction: "debit" | "credit";
  amountCents: number;
  currency: string;
  fxRate?: string;
}
