CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE ledger_transactions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), transaction_id UUID NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE ledger_entries (id BIGSERIAL PRIMARY KEY, ledger_transaction_id UUID NOT NULL REFERENCES ledger_transactions(id), account_id UUID NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('debit','credit')), amount_cents BIGINT NOT NULL CHECK(amount_cents>0), currency CHAR(3) NOT NULL, fx_rate NUMERIC(18,8), prev_hash TEXT, entry_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX idx_ledger_entries_transaction ON ledger_entries(ledger_transaction_id); CREATE INDEX idx_ledger_entries_account ON ledger_entries(account_id,created_at);
