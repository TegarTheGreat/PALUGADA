-- An account's tokens and money are counted per calendar month (F1.9, L11).
--
-- F1.9 sets a budget per period -- monthly -- beside the per-task one, and an
-- account counted for its whole life: spent once, spent for ever. A division
-- that used its allowance in October was still out in December, and only the
-- owner raising its ceiling ever gave it back. On the live run of 2026-10-02
-- one request spent 96% of a division's allowance, which would never have
-- come back on its own.
--
-- The counts now belong to the month they were spent in, in UTC like the
-- company's monthly ceiling. `period_start` is the month the counts are of.
-- The first reservation or charge of a new month starts the chain's counts
-- again before it checks them, so admission is exact; the worker's watch does
-- the same for every account, so a page read on the first shows the new month
-- and not the last one's total.
--
-- What is reserved is not touched: it is held by work still running, which
-- releases it or turns it into spend. Existing accounts are counted from this
-- month: what they spent stays spent until it ends.
--
-- The functions are 0024's, with the new month started after the chain's
-- locks are taken, in the order every budget function takes them (0040).

ALTER TABLE budget_accounts
  ADD COLUMN period_start timestamptz NOT NULL
    DEFAULT (date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC');

-- The application role moves the running totals, and starting a month is one.
GRANT UPDATE (period_start) ON budget_accounts TO palugada_app;

-- The month now, as the instant it began in UTC.
CREATE FUNCTION app.budget_month() RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
$$;

-- Starts a new month in every account of `chain` whose counts are of a passed
-- one, and says how many. The caller holds the chain's locks.
CREATE FUNCTION app.budget_new_period(chain uuid[]) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE started integer;
BEGIN
  UPDATE budget_accounts
     SET tokens_spent = 0, money_spent_cents = 0, period_start = app.budget_month()
   WHERE id = ANY(chain) AND period_start < app.budget_month();
  GET DIAGNOSTICS started = ROW_COUNT;
  RETURN started;
END $$;

CREATE OR REPLACE FUNCTION app.budget_reserve(
  account_id uuid, tokens bigint
) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE chain uuid[];
BEGIN
  chain := app.budget_chain(account_id);
  IF chain IS NULL THEN RETURN false; END IF;

  PERFORM app.budget_lock_chain(chain);
  PERFORM app.budget_new_period(chain);

  -- Checked across the whole chain before anything moves. A reservation the
  -- division can afford and the company cannot is a reservation nobody can
  -- afford.
  IF EXISTS (
    SELECT 1 FROM budget_accounts
     WHERE id = ANY(chain)
       AND tokens_spent + tokens_reserved + tokens > tokens_max
  ) THEN
    RETURN false;
  END IF;

  UPDATE budget_accounts
     SET tokens_reserved = tokens_reserved + tokens
   WHERE id = ANY(chain);
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION app.budget_spend(
  account_id uuid, tokens bigint, money_cents bigint, from_reservation bigint
) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE chain uuid[];
BEGIN
  chain := app.budget_chain(account_id);
  IF chain IS NULL THEN RETURN false; END IF;

  PERFORM app.budget_lock_chain(chain);
  PERFORM app.budget_new_period(chain);

  IF EXISTS (
    SELECT 1 FROM budget_accounts
     WHERE id = ANY(chain)
       AND (tokens_spent + tokens > tokens_max
            OR money_spent_cents + money_cents > money_max_cents)
  ) THEN
    RETURN false;
  END IF;

  UPDATE budget_accounts
     SET tokens_spent      = tokens_spent + tokens,
         money_spent_cents = money_spent_cents + money_cents,
         tokens_reserved   = GREATEST(0, tokens_reserved - LEAST(from_reservation, tokens))
   WHERE id = ANY(chain);
  RETURN true;
END $$;
