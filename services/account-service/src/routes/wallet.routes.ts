import type { FastifyInstance } from "fastify";
import { fail } from "../lib/fail.js";
import { setContext } from "../lib/context.js";
import {
  applyWalletOperation,
  createUser,
  createWallet,
  getWallet,
  listWallets,
} from "../services/wallet.service.js";

export async function walletRoutes(app: FastifyInstance) {
  app.post<{ Body: { email?: string; fullName?: string; phone?: string } }>(
    "/users",
    async (request, reply) => {
      const { email, fullName, phone } = request.body;
      if (!email || !fullName)
        return fail(
          reply,
          400,
          "VALIDATION_ERROR",
          "email and fullName are required",
        );
      try {
        const user = await createUser({ email, fullName, phone });
        return reply.code(201).send(user);
      } catch (error: any) {
        if (error.code === "P2002")
          return fail(
            reply,
            409,
            "USER_EXISTS",
            "A user with this email already exists",
          );
        throw error;
      }
    },
  );

  app.post<{
    Body: {
      userId?: string;
      currency?: string;
      initialBalanceCents?: number;
    };
  }>("/wallets", async (request, reply) => {
    const { userId, currency, initialBalanceCents = 0 } = request.body;
    if (
      !userId ||
      !/^[A-Z]{3}$/.test(currency ?? "") ||
      !Number.isSafeInteger(initialBalanceCents) ||
      initialBalanceCents < 0
    )
      return fail(
        reply,
        400,
        "VALIDATION_ERROR",
        "Valid userId, currency and integer initialBalanceCents are required",
      );
    try {
      const wallet = await createWallet({
        userId,
        currency: currency!,
        initialBalanceCents,
      });
      return reply.code(201).send(wallet);
    } catch (error: any) {
      if (error.code === "P2002")
        return fail(
          reply,
          409,
          "DUPLICATE_WALLET_CURRENCY",
          "User already owns this currency wallet",
        );
      if (error.code === "P2003")
        return fail(reply, 404, "USER_NOT_FOUND", "User was not found");
      throw error;
    }
  });

  app.get<{ Params: { userId: string } }>(
    "/wallets/:userId",
    async (request) => {
      setContext({ userId: request.params.userId });
      return {
        userId: request.params.userId,
        wallets: await listWallets(request.params.userId),
      };
    },
  );

  app.get<{ Params: { walletId: string } }>(
    "/wallets/:walletId/balance",
    async (request, reply) => {
      const w = await getWallet(request.params.walletId);
      return w ?? fail(reply, 404, "WALLET_NOT_FOUND", "Wallet was not found");
    },
  );

  app.post<{
    Params: { walletId: string };
    Body: { operationKey?: string; deltaCents?: number };
  }>("/wallets/:walletId/operations", async (request, reply) => {
    const { operationKey, deltaCents } = request.body;
    if (!operationKey || !Number.isSafeInteger(deltaCents) || !deltaCents)
      return fail(
        reply,
        400,
        "VALIDATION_ERROR",
        "operationKey and a non-zero integer deltaCents are required",
      );
    const result = await applyWalletOperation({
      walletId: request.params.walletId,
      operationKey,
      deltaCents,
    });
    return result
      ? result
      : fail(
          reply,
          422,
          "INSUFFICIENT_FUNDS_OR_WALLET_UNAVAILABLE",
          "Insufficient available balance or unavailable wallet",
        );
  });
}
