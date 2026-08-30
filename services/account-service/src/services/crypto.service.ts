import crypto from "node:crypto";
import { envVars } from "../config/env.utils.js";

const kek = () =>
  crypto.createHash("sha256").update(envVars.FIELD_ENCRYPTION_KEK).digest();

function encrypted(value: string, key: Buffer) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  return {
    ciphertext: Buffer.concat([c.update(value, "utf8"), c.final()]),
    iv,
    tag: c.getAuthTag(),
  };
}

export function envelope(fullName: string, phone?: string) {
  const dek = crypto.randomBytes(32),
    name = encrypted(fullName, dek),
    phoneValue = phone ? encrypted(phone, dek) : undefined,
    iv = crypto.randomBytes(12),
    c = crypto.createCipheriv("aes-256-gcm", kek(), iv);
  const wrapped = Buffer.concat([iv, c.getAuthTag(), c.update(dek), c.final()]);
  return { name, phone: phoneValue, wrapped };
}
