import { prisma } from "../lib/prisma.js";

export const HISTORY_DEFAULT_LIMIT = 50;
export const HISTORY_MAX_LIMIT = 100;

export type HistoryCursor = {
  createdAt: string;
  id: string;
};

export function encodeCursor(cursor: HistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

// Opaque to clients: base64url JSON carrying only the sort position
// (creation timestamp + unique id tiebreaker). No account data inside,
// and the wallet-ownership filter is always applied server-side, so a
// forged cursor can never widen the result set.
export function decodeCursor(raw: string): HistoryCursor | null {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    );
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as any).createdAt !== "string" ||
      Number.isNaN(Date.parse((parsed as any).createdAt)) ||
      typeof (parsed as any).id !== "string" ||
      (parsed as any).id.length === 0
    )
      return null;
    return {
      createdAt: (parsed as any).createdAt,
      id: (parsed as any).id,
    };
  } catch {
    return null;
  }
}

export function parseHistoryQuery(query: {
  walletId?: unknown;
  limit?: unknown;
  cursor?: unknown;
}):
  | { status: 400; error: "VALIDATION_ERROR"; message: string }
  | { walletId: string; limit: number; cursor: HistoryCursor | null } {
  if (typeof query.walletId !== "string" || !query.walletId)
    return {
      status: 400,
      error: "VALIDATION_ERROR",
      message: "walletId is required",
    };
  let limit = HISTORY_DEFAULT_LIMIT;
  if (query.limit !== undefined) {
    const n = Number(query.limit);
    if (!Number.isSafeInteger(n) || n < 1 || n > HISTORY_MAX_LIMIT)
      return {
        status: 400,
        error: "VALIDATION_ERROR",
        message: `limit must be an integer between 1 and ${HISTORY_MAX_LIMIT}`,
      };
    limit = n;
  }
  let cursor: HistoryCursor | null = null;
  if (query.cursor !== undefined) {
    if (typeof query.cursor !== "string")
      return {
        status: 400,
        error: "VALIDATION_ERROR",
        message: "cursor is malformed",
      };
    cursor = decodeCursor(query.cursor);
    if (!cursor)
      return {
        status: 400,
        error: "VALIDATION_ERROR",
        message: "cursor is malformed",
      };
  }
  return { walletId: query.walletId, limit, cursor };
}

export async function listHistory(input: {
  walletId: string;
  limit: number;
  cursor: HistoryCursor | null;
}) {
  const { walletId, limit, cursor } = input;
  const rows = await prisma.transaction.findMany({
    where: {
      AND: [
        {
          OR: [
            { senderWalletId: walletId },
            { recipientWalletId: walletId },
          ],
        },
        ...(cursor
          ? [
              {
                OR: [
                  { createdAt: { lt: new Date(cursor.createdAt) } },
                  {
                    createdAt: new Date(cursor.createdAt),
                    id: { lt: cursor.id },
                  },
                ],
              },
            ]
          : []),
      ],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    // One extra row proves a next page exists without a COUNT(*) scan.
    take: limit + 1,
    select: {
      id: true,
      senderWalletId: true,
      recipientWalletId: true,
      amountCents: true,
      currency: true,
      destinationAmountCents: true,
      destinationCurrency: true,
      fxRate: true,
      status: true,
      createdAt: true,
      completedAt: true,
    },
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      id: r.id,
      senderWalletId: r.senderWalletId,
      recipientWalletId: r.recipientWalletId,
      amountCents: r.amountCents.toString(),
      currency: r.currency,
      destinationAmountCents: r.destinationAmountCents?.toString() ?? null,
      destinationCurrency: r.destinationCurrency ?? null,
      fxRate: r.fxRate?.toString() ?? null,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      completedAt: r.completedAt?.toISOString() ?? null,
    })),
    nextCursor:
      hasMore && last
        ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null,
    hasMore,
  };
}
