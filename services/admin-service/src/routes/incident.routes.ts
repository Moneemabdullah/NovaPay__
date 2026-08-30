import type { FastifyInstance } from "fastify";
import { fail } from "../lib/fail.js";
import { createIncidentNote } from "../services/incident.service.js";
import {
  checkLedgerInvariant,
  verifyAudit,
} from "../services/ledger.service.js";

export async function incidentRoutes(app: FastifyInstance) {
  app.post<{
    Body: { adminUser?: string; transactionId?: string; note?: string };
  }>("/incidents", async (request, reply) => {
    const { adminUser, transactionId, note } = request.body;
    if (!adminUser || !note)
      return fail(
        reply,
        400,
        "VALIDATION_ERROR",
        "adminUser and note are required",
      );
    return reply
      .code(201)
      .send(await createIncidentNote({ adminUser, transactionId, note }));
  });

  app.get("/ledger-invariant", async (_req, reply) => {
    const result = await checkLedgerInvariant();
    return reply.code(result.status).send(await result.json());
  });

  app.get("/audit/verify", async (_req, reply) => {
    const result = await verifyAudit();
    return reply.code(result.status).send(await result.json());
  });
}
