export interface TransactionInput {
  senderWalletId: string;
  recipientWalletId: string;
  amountCents: number;
  currency: string;
  sourceAmountCents?: number;
  sourceCurrency?: string;
  destinationAmountCents?: number;
  destinationCurrency?: string;
  quoteId?: string;
}
