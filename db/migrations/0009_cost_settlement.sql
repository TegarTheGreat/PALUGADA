-- Phase 4: settling what an action actually cost (F8.5, section 8.8).

-- ---------------------------------------------------------------------------
-- app.budget_spend refuses a charge that would breach the ceiling, which is
-- what admission control needs: the money has not been spent yet, so refusing
-- prevents it. Settlement is the opposite situation. The provider has already
-- billed, and a ceiling cannot un-bill it; refusing the adjustment would leave
-- the account claiming an amount the company does not actually owe, which is
-- the one thing an accounting record must not do.
--
-- So this function adjusts unconditionally and the ceiling is enforced where
-- it can still change the outcome -- before the call, on the estimate. An
-- overrun becomes a visible overspend rather than a quiet understatement, and
-- F11.4's alert is what turns it into the owner's problem.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.budget_settle(
  account_id uuid, delta_cents bigint
) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE settled bigint;
BEGIN
  UPDATE budget_accounts
     -- Clamped at zero: a refund larger than what was charged would otherwise
     -- turn a bookkeeping mistake into negative spend, which reads as credit.
     SET money_spent_cents = GREATEST(0, money_spent_cents + delta_cents)
   WHERE id = account_id
  RETURNING money_spent_cents INTO settled;

  IF settled IS NULL THEN
    RAISE EXCEPTION 'budget account % does not exist', account_id
      USING ERRCODE = '23503';
  END IF;

  RETURN settled;
END $$;
