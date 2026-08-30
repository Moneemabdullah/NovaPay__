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
  const dek = crypto.randomBytes(32);
  const name = encrypted(fullName, dek);
  const phoneValue = phone ? encrypted(phone, dek) : undefined;

  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", kek(), iv);

  const encryptedDek = Buffer.concat([c.update(dek), c.final()]);
  const authTag = c.getAuthTag();

  const wrapped = Buffer.concat([iv, authTag, encryptedDek]);

  return { name, phone: phoneValue, wrapped };
}
