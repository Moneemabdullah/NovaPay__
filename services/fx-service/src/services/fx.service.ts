import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export const rates: Record<string, string> = {
  USD_BDT: "118.50000000",
  USD_EUR: "0.92000000",
  EUR_USD: "1.09000000",
  BDT_USD: "0.00843882",
};

export async function createQuote(
  baseCurrency: string,
  quoteCurrency: string,
  rate: string,
) {
  return prisma.fxQuote.create({
    data: {
      baseCurrency,
      quoteCurrency,
      rate: new Prisma.Decimal(rate),
      expiresAt: new Date(Date.now() + 60000),
    },
  });
}

export async function getQuote(id: string) {
  return prisma.fxQuote.findUnique({ where: { id } });
}

export async function consumeQuote(id: string, transactionId: string) {
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      rate: Prisma.Decimal;
      base_currency: string;
      quote_currency: string;
    }>
  >(
    Prisma.sql`UPDATE fx_quotes SET used=true, used_at=now(), status='consumed', used_by_transaction_id=${transactionId}::uuid WHERE id=${id}::uuid AND used=false AND expires_at>now() RETURNING id,rate,base_currency,quote_currency`,
  );
  if (rows[0])
    return {
      consumed: true as const,
      quote: {
        id: rows[0].id,
        rate: rows[0].rate,
        baseCurrency: rows[0].base_currency,
        quoteCurrency: rows[0].quote_currency,
      },
    };
  const quote = await prisma.fxQuote.findUnique({ where: { id } });
  return { consumed: false as const, quote };
}
