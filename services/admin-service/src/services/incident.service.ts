import { prisma } from "../lib/prisma.js";

export function createIncidentNote(input: {
  adminUser: string;
  transactionId?: string;
  note: string;
}) {
  return prisma.incidentNote.create({ data: input });
}
