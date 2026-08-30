CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE fx_quotes (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), base_currency CHAR(3) NOT NULL, quote_currency CHAR(3) NOT NULL, rate NUMERIC(18,8) NOT NULL, provider TEXT NOT NULL DEFAULT 'static-development-provider', issued_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL, used BOOLEAN NOT NULL DEFAULT false, used_at TIMESTAMPTZ, status TEXT NOT NULL DEFAULT 'active', used_by_transaction_id UUID);
CREATE INDEX idx_fx_quotes_expires ON fx_quotes(expires_at);
