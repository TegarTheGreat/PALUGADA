-- ---------------------------------------------------------------------------
-- Budget inheritance (PRD v2 F1.6, principle 8)
--
-- 0023 gave an account a scope and a parent. This makes the parent mean
-- something: a reservation or a charge against a division's account is also a
-- reservation or a charge against the company's, so a division cannot spend
-- money the company does not have, and raising a division's ceiling cannot
-- raise the company's.
--
-- All-or-nothing, and that is the whole design. A charge that succeeded
-- against the division and failed against the company would leave the two
-- disagreeing about what has been spent, and there is no good way to discover
-- which one is right afterwards. So the chain is locked in a fixed order, the
-- whole chain is checked, and only then does anything move.
--
-- Locking in id order matters more than it looks: two transactions holding
-- overlapping chains in different orders is a deadlock, and a deadlock in the
-- budget path would show up as random task failures under load.
--
-- The behaviour of an account with no parent -- which is every account created
-- before this migration -- is unchanged.
-- ---------------------------------------------------------------------------

-- The account and every ancestor, nearest first.
CREATE OR REPLACE FUNCTION app.budget_chain(account_id uuid) RETURNS uuid[]
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE up AS (
    SELECT id, parent_account_id, 0 AS depth
      FROM budget_accounts WHERE id = account_id
    UNION ALL
    SELECT p.id, p.parent_account_id, up.depth + 1
      FROM budget_accounts p JOIN up ON up.parent_account_id = p.id
  )
  SELECT array_agg(id ORDER BY depth) FROM up;
$$;

-- Locks every account in a chain in a fixed order, so two overlapping chains
-- cannot deadlock against each other.
CREATE OR REPLACE FUNCTION app.budget_lock_chain(chain uuid[]) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
  FOR target IN SELECT unnest(chain) ORDER BY 1 LOOP
    PERFORM 1 FROM budget_accounts WHERE id = target FOR UPDATE;
  END LOOP;
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

CREATE OR REPLACE FUNCTION app.budget_release(
  account_id uuid, tokens bigint
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE chain uuid[];
BEGIN
  chain := app.budget_chain(account_id);
  IF chain IS NULL THEN RETURN; END IF;

  UPDATE budget_accounts
     SET tokens_reserved = GREATEST(0, tokens_reserved - tokens)
   WHERE id = ANY(chain);
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
