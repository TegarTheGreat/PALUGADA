-- ---------------------------------------------------------------------------
-- A settlement reaches every account the charge reached (PRD v2 F1.6, F8.5)
--
-- 0024 made spending inheritable: `budget_spend` charges an account and every
-- ancestor, which is what makes a division's ceiling a limit inside the
-- company's. It left `budget_settle` -- written in 0009, before accounts had
-- parents -- adjusting one account. The broker charges a capability's
-- estimate with `budget_spend` and refunds or settles it with
-- `budget_settle`, so after 0024 the two touched different sets of rows:
--
--   - A refunded estimate (the action failed) came back to the division and
--     stayed charged to the company. Every failed action left phantom spend
--     on every account above the one that paid, and a company whose actions
--     sometimes fail drifted towards F1.7's pause on money it never spent.
--   - A settled overrun (the vendor billed more than the estimate) reached the
--     division and not the company, so the company's ceiling undercounted
--     exactly the spend it most needed to see.
--
-- And a second defect under the first. 0009 says an overrun "becomes a
-- visible overspend rather than a quiet understatement", because the provider
-- has already billed and a ceiling cannot un-bill it. 0003's CHECK forbids any
-- spend above the ceiling, so the settlement meant to record the overspend
-- failed instead -- after the vendor call, as an error from an action that had
-- happened, which the engine then retried. The CHECK is dropped: admission is
-- enforced where it can still change the outcome, in `budget_spend`, which
-- refuses a charge that would breach any ceiling in the chain. What is left
-- above the ceiling after that is a bill, and a bill is recorded.
-- ---------------------------------------------------------------------------

ALTER TABLE budget_accounts DROP CONSTRAINT budget_money_within_max;

CREATE OR REPLACE FUNCTION app.budget_settle(
  account_id uuid, delta_cents bigint
) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  chain uuid[];
  settled bigint;
BEGIN
  chain := app.budget_chain(account_id);
  IF chain IS NULL THEN
    RAISE EXCEPTION 'budget account % does not exist', account_id
      USING ERRCODE = '23503';
  END IF;

  -- The same lock order `budget_spend` takes, so a settlement and a charge
  -- on overlapping chains queue rather than deadlock.
  PERFORM app.budget_lock_chain(chain);

  UPDATE budget_accounts
     -- Clamped at zero per account: a refund larger than what was charged
     -- would otherwise turn a bookkeeping mistake into negative spend, which
     -- reads as credit.
     SET money_spent_cents = GREATEST(0, money_spent_cents + delta_cents)
   WHERE id = ANY(chain);

  SELECT money_spent_cents INTO settled FROM budget_accounts WHERE id = account_id;
  RETURN settled;
END $$;
