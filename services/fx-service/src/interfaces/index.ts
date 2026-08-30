export interface FxQuote {
  id: string;
  baseCurrency: string;
  quoteCurrency: string;
  rate: string;
  expiresAt: Date;
  used: boolean;
}
