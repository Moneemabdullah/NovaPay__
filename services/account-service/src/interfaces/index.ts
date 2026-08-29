export interface Wallet {
  id: string;
  userId: string;
  currency: string;
  balanceCents: bigint;
  status: string;
  version: bigint;
}

export interface WalletWithBalance {
  wallet: Wallet;
  balance: string;
  currency: string;
}
