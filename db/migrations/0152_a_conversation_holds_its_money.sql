-- A turn of the owner's conversation with a company's CEO holds its money
-- (F19.12, STATUS 2.205).
--
-- Each model turn reserves its estimate from the CEO's account before the
-- call, and spends from that reservation when the call answers. A process
-- that dies between the two would leave the account short by the
-- reservation for good, since nothing else knows it was made: so the
-- reservation is written here in the same transaction as `budget_reserve`,
-- and the turn deletes its row in the transaction that spends or lets the
-- reservation go. A row still here long after any live turn could be is a
-- turn whose process died, and the worker's sweep releases it.

CREATE TABLE conversation_holds (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- The account the tokens were reserved from; its chain above it holds them too.
  budget_account_id uuid NOT NULL,
  tokens            integer NOT NULL CHECK (tokens > 0),
  held_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, budget_account_id) REFERENCES budget_accounts (company_id, id) ON DELETE CASCADE
);

-- What the sweep reads: the holds of a company older than a live turn.
CREATE INDEX conversation_holds_held_at ON conversation_holds (company_id, held_at);

SELECT app.enable_tenant_rls('conversation_holds');

-- The application role reserves, spends and releases, so it writes a hold
-- and deletes it; nothing ever changes one. Not exported: a hold is money in
-- flight on this deployment, and a restored company has none.
REVOKE UPDATE ON conversation_holds FROM palugada_app;
GRANT DELETE ON conversation_holds TO palugada_app;
