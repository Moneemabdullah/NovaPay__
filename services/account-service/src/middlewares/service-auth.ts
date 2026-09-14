import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { fail } from "../lib/fail.js";

export type PeerTokens = Record<string, string>;
// Rule format: "*" (everything) or "METHOD /exact-path" or
// "METHOD /prefix/*" (prefix match). Method may also be "*".
export type AllowRules = Record<string, string[]>;

// Liveness and scraping stay open; everything else needs a service identity.
const PUBLIC_PATHS = ["/health", "/metrics"];

function timingEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function allowed(
  rules: string[] | undefined,
  method: string,
  url: string,
): boolean {
  if (!rules) return false;
  return rules.some((rule) => {
    if (rule === "*") return true;
    const space = rule.indexOf(" ");
    if (space < 0) return false;
    const ruleMethod = rule.slice(0, space);
    const rulePath = rule.slice(space + 1);
    if (ruleMethod !== "*" && ruleMethod !== method) return false;
    if (rulePath === "*") return true;
    if (rulePath.endsWith("*"))
      return url.startsWith(rulePath.slice(0, -1));
    return url === rulePath;
  });
}

export function registerServiceAuth(
  app: FastifyInstance,
  getPeers: () => PeerTokens,
  allow: AllowRules,
) {
  app.addHook("onRequest", (request, reply, done) => {
    const pathname = String(request.url).split("?")[0];
    if (PUBLIC_PATHS.includes(pathname)) return done();
    const id = request.headers["x-service-id"];
    const token = request.headers["x-service-token"];
    if (
      typeof id !== "string" ||
      typeof token !== "string" ||
      !id ||
      !token
    ) {
      fail(reply, 401, "UNAUTHORIZED", "Service credentials required");
      return done();
    }
    const expected = getPeers()[id];
    if (!expected || !timingEqual(token, expected)) {
      // Same response for unknown identity and wrong secret: never reveal
      // which half failed.
      fail(reply, 401, "UNAUTHORIZED", "Service credentials required");
      return done();
    }
    if (!allowed(allow[id], request.method, pathname)) {
      fail(reply, 403, "FORBIDDEN", "Service not authorized for this endpoint");
      return done();
    }
    done();
  });
}
