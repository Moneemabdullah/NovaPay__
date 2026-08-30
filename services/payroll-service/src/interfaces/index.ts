export interface PayrollItemInput {
  recipientWalletId: string;
  amountCents: number;
}

export interface CreatePayrollJobInput {
  employerAccountId: string;
  items: PayrollItemInput[];
}
