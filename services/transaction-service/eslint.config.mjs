// Minimal ESLint flat config for NovaPay services.
//
// Scope: catch real bugs (undefined vars, unused locals, bad syntax) without
// forcing a style migration. Type-aware rules are OFF (no type-checking at
// lint time; `tsc --noEmit` in CI covers types). `no-explicit-any` is OFF
// because Fastify handlers/catch clauses legitimately use `any`.
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", "dist/**", "coverage/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" },
      ],
      // Existing code uses ternary-as-statement in two places
      // (ledger.service.ts validateBatch, crash-recovery test totals);
      // allow that pattern rather than rewriting working code.
      "@typescript-eslint/no-unused-expressions": [
        "error",
        { allowTernary: true },
      ],
      "no-unused-vars": "off",
    },
  },
);
