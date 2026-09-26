-- ---------------------------------------------------------------------------
-- One lock order for budget accounts, and one live factor per secret
--
-- `budget_release` (0024) updated its chain in whatever order the UPDATE met
-- the rows, while `budget_spend` and `budget_settle` lock the chain in id
-- order first. Two transactions touching overlapping chains -- the stop
-- button releasing a hundred reservations while a worker records usage --
-- could each hold one account and wait for the other's. PostgreSQL resolves
-- that by aborting one, and when the one aborted is the stop, every
-- cancellation it made is rolled back and the owner is shown an error. The
-- release takes the chain in the same order as everything else now.
--
-- And a secret may back at most one live authenticator. Two sharing one are
-- one factor, and each refuses the other's codes as replays; `enrolTotp`
-- already refused a second one, but in application code, so two replicas
-- enrolling the owner's configured factor at the same boot could both get
-- past the check. If this index fails to build, two live authenticators
-- already share a secret: revoke one in the console and migrate again.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.budget_release(
  account_id uuid, tokens bigint
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE chain uuid[];
BEGIN
  chain := app.budget_chain(account_id);
  IF chain IS NULL THEN RETURN; END IF;

  PERFORM app.budget_lock_chain(chain);

  UPDATE budget_accounts
     SET tokens_reserved = GREATEST(0, tokens_reserved - tokens)
   WHERE id = ANY(chain);
END $$;

CREATE UNIQUE INDEX owner_authenticators_live_secret_idx
  ON owner_authenticators (secret_ref)
  WHERE secret_ref IS NOT NULL AND revoked_at IS NULL;
