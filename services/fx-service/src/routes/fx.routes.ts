import type { FastifyInstance } from "fastify";
import { envVars } from "../config/env.utils.js";
import { fail } from "../lib/fail.js";
import { fxProviderFailures } from "../lib/metrics.js";
import {
  consumeQuote,
  createQuote,
  getQuote,
  rates,
} from "../services/fx.service.js";

export async function fxRoutes(app: FastifyInstance) {
  app.post<{ Body: { baseCurrency?: string; quoteCurrency?: string } }>(
    "/quote",
    async (request, reply) => {
      const { baseCurrency, quoteCurrency } = request.body;
      if (
        !/^[A-Z]{3}$/.test(baseCurrency ?? "") ||
        !/^[A-Z]{3}$/.test(quoteCurrency ?? "") ||
        baseCurrency === quoteCurrency
      )
        return fail(
          reply,
          400,
          "VALIDATION_ERROR",
          "Two distinct ISO currencies are required",
        );
      if (envVars.FX_PROVIDER_DOWN) {
        fxProviderFailures.inc();
        return fail(
          reply,
          503,
          "FX_PROVIDER_UNAVAILABLE",
          "FX provider is unavailable; no cached rate is used",
        );
      }
      const rate = rates[`${baseCurrency}_${quoteCurrency}`];
      if (!rate) {
        fxProviderFailures.inc();
        return fail(
          reply,
          503,
          "FX_PROVIDER_UNAVAILABLE",
          "The provider has no rate for this pair",
        );
      }
      const quote = await createQuote(baseCurrency!, quoteCurrency!, rate);
      return reply.code(201).send(quote);
    },
  );

  app.get<{ Params: { id: string } }>("/quote/:id", async (request, reply) => {
    const quote = await getQuote(request.params.id);
    return (
      quote ?? fail(reply, 404, "FX_QUOTE_NOT_FOUND", "Quote was not found")
    );
  });

  app.post<{ Params: { id: string }; Body: { transactionId?: string } }>(
    "/quote/:id/consume",
    async (request, reply) => {
      if (!request.body.transactionId)
        return fail(
          reply,
          400,
          "VALIDATION_ERROR",
          "transactionId is required",
        );
      const result = await consumeQuote(
        request.params.id,
        request.body.transactionId,
      );
      if (result.consumed) return result.quote;
      if (!result.quote)
        return fail(reply, 404, "FX_QUOTE_NOT_FOUND", "Quote was not found");
      return fail(
        reply,
        409,
        result.quote.used ? "FX_QUOTE_ALREADY_USED" : "FX_QUOTE_EXPIRED",
        result.quote.used ? "Quote was already consumed" : "Quote expired",
      );
    },
  );
}
