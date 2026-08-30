import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { envelope } from "./crypto.service.js";

export async function createUser(input: {
  email: string;
  fullName: string;
  phone?: string;
}) {
  const e = envelope(input.fullName, input.phone);
  return prisma.user.create({
    data: {
      email: input.email,
      fullNameEnc: e.name.ciphertext,
      fullNameIv: e.name.iv,
      fullNameTag: e.name.tag,
      phoneEnc: e.phone?.ciphertext,
      phoneIv: e.phone?.iv,
      phoneTag: e.phone?.tag,
      dekWrapped: e.wrapped,
    },
    select: { id: true, email: true, createdAt: true },
  });
}

export async function createWallet(input: {
  userId: string;
  currency: string;
  initialBalanceCents?: number;
}) {
  const wallet = await prisma.wallet.create({
    data: {
      userId: input.userId,
      currency: input.currency,
      balanceCents: BigInt(input.initialBalanceCents ?? 0),
    },
  });

  return {
    ...wallet,
    balanceCents: wallet.balanceCents.toString(),
  };
}

export async function listWallets(userId: string) {
  const wallets = await prisma.wallet.findMany({
    where: { userId },
    select: {
      id: true,
      currency: true,
      balanceCents: true,
      status: true,
    },
    orderBy: { currency: "asc" },
  });

  return wallets.map((wallet) => ({
    ...wallet,
    balanceCents: wallet.balanceCents.toString(),
  }));
}

export async function getWallet(walletId: string) {
  const wallet = await prisma.wallet.findUnique({
    where: { id: walletId },
    select: {
      id: true,
      balanceCents: true,
      currency: true,
      status: true,
    },
  });

  if (!wallet) return null;

  return {
    ...wallet,
    balanceCents: wallet.balanceCents.toString(),
  };
}

export async function getWalletOperation(
  walletId: string,
  operationKey: string,
) {
  return prisma.walletBalanceOperation.findUnique({
    where: { walletId_operationKey: { walletId, operationKey } },
    select: { walletId: true, operationKey: true, deltaCents: true },
  });
}

export async function applyWalletOperation(input: {
  walletId: string;
  operationKey: string;
  deltaCents: number;
}) {
  const { walletId, operationKey, deltaCents } = input;
  return prisma.$transaction(async (tx) => {
    const replay = await tx.walletBalanceOperation.findUnique({
      where: { walletId_operationKey: { walletId, operationKey } },
    });
    if (replay) return tx.wallet.findUnique({ where: { id: walletId } });
    const changed = await tx.$executeRaw(
      Prisma.sql`UPDATE wallets SET balance_cents = balance_cents + ${BigInt(deltaCents)}, version = version + 1, updated_at = now() WHERE id = ${walletId}::uuid AND status = 'active' AND balance_cents + ${BigInt(deltaCents)} >= 0`,
    );
    if (!changed) return null;
    await tx.walletBalanceOperation.create({
      data: { walletId, operationKey, deltaCents: BigInt(deltaCents) },
    });
    return tx.wallet.findUnique({ where: { id: walletId } });
  });
}
