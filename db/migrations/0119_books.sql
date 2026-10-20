-- The company's own books, by double entry (STATUS 2.139).
--
-- `ledger.read` was catalogued and bound to nothing, so the bookkeeper was
-- told to keep the ledger balancing and had no ledger. The platform now
-- keeps one: a chart of accounts, and entries whose debits and credits are
-- equal -- checked here, at commit, whatever wrote them -- that are never
-- rewritten, only reversed by another entry. An accounting service the
-- owner connects still takes the names over (src/capabilities/books.ts).

CREATE TABLE ledger_accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- As accountants number them: 1 assets, 2 liabilities, 3 equity, 4
  -- income, 5 expenses, and the rest of the digits the company's own.
  code        text NOT NULL,
  name        text NOT NULL,
  kind        text NOT NULL,
  -- What the platform posts to on its own -- cash, what customers owe,
  -- sales -- named so it finds them whatever the owner calls them. Null for
  -- an account the owner added.
  system_key  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT ledger_accounts_company_scoped_key UNIQUE (company_id, id),
  CONSTRAINT ledger_accounts_one_code UNIQUE (company_id, code),
  CONSTRAINT ledger_accounts_one_system_key UNIQUE (company_id, system_key),
  CONSTRAINT ledger_accounts_code_shape CHECK (code ~ '^[0-9]{1,8}$'),
  CONSTRAINT ledger_accounts_name_shape CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT ledger_accounts_kind_known CHECK (kind IN ('asset', 'liability', 'equity', 'income', 'expense')),
  CONSTRAINT ledger_accounts_system_known CHECK (
    system_key IS NULL OR system_key IN ('cash', 'receivable', 'payable', 'tax', 'equity', 'revenue', 'expense'))
);
SELECT app.enable_tenant_rls('ledger_accounts');
-- The application role opens the books and adds an account; it renames or
-- archives none.
REVOKE UPDATE ON ledger_accounts FROM palugada_app;

CREATE TABLE journal_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  entry_date  date NOT NULL,
  memo        text NOT NULL,
  -- One currency an entry; balances are kept per currency.
  currency    text NOT NULL,
  written_by  text NOT NULL,
  -- The work that wrote it; null for the owner's.
  task_id     uuid,
  -- Written by work that had read content from outside (F8.9): its memo is
  -- read back as data.
  outside     boolean NOT NULL DEFAULT false,
  -- The entry this one undoes, line for line.
  reverses    uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT journal_entries_company_scoped_key UNIQUE (company_id, id),
  CONSTRAINT journal_entries_task_fkey
    FOREIGN KEY (company_id, task_id) REFERENCES tasks (company_id, id) ON DELETE SET NULL (task_id),
  CONSTRAINT journal_entries_reverses_fkey
    FOREIGN KEY (company_id, reverses) REFERENCES journal_entries (company_id, id),
  CONSTRAINT journal_entries_reversed_once UNIQUE (company_id, reverses),
  CONSTRAINT journal_entries_memo_shape CHECK (length(btrim(memo)) BETWEEN 1 AND 500),
  CONSTRAINT journal_entries_currency_shape CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT journal_entries_writer_known CHECK (written_by IN ('owner', 'agent'))
);
CREATE INDEX journal_entries_by_date ON journal_entries (company_id, entry_date DESC, created_at DESC);
SELECT app.enable_tenant_rls('journal_entries');
REVOKE UPDATE ON journal_entries FROM palugada_app;

CREATE TABLE journal_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  entry_id      uuid NOT NULL,
  account_id    uuid NOT NULL,
  debit_cents   bigint NOT NULL DEFAULT 0,
  credit_cents  bigint NOT NULL DEFAULT 0,
  CONSTRAINT journal_lines_company_scoped_key UNIQUE (company_id, id),
  CONSTRAINT journal_lines_entry_fkey
    FOREIGN KEY (company_id, entry_id) REFERENCES journal_entries (company_id, id) ON DELETE CASCADE,
  CONSTRAINT journal_lines_account_fkey
    FOREIGN KEY (company_id, account_id) REFERENCES ledger_accounts (company_id, id),
  -- A debit or a credit, of something.
  CONSTRAINT journal_lines_one_side CHECK (
    (debit_cents > 0 AND credit_cents = 0) OR (credit_cents > 0 AND debit_cents = 0)),
  CONSTRAINT journal_lines_sane CHECK (debit_cents <= 100000000000000 AND credit_cents <= 100000000000000)
);
CREATE INDEX journal_lines_of_entry ON journal_lines (entry_id);
CREATE INDEX journal_lines_of_account ON journal_lines (account_id);
SELECT app.enable_tenant_rls('journal_lines');
REVOKE UPDATE ON journal_lines FROM palugada_app;

-- Every entry balances, checked when its transaction commits: at least two
-- lines, debits equal to credits. Whatever wrote it -- a capability, the
-- owner's console, a statement typed at a prompt.
CREATE FUNCTION app.journal_entry_balances() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  -- Read through jsonb: a row of either table, and PL/pgSQL resolves a field
  -- named in a branch not taken.
  entry uuid := (to_jsonb(NEW) ->> CASE WHEN TG_TABLE_NAME = 'journal_entries' THEN 'id' ELSE 'entry_id' END)::uuid;
  debits numeric;
  credits numeric;
  lines integer;
BEGIN
  SELECT coalesce(sum(debit_cents), 0), coalesce(sum(credit_cents), 0), count(*)
    INTO debits, credits, lines
    FROM journal_lines WHERE entry_id = entry;
  IF lines < 2 OR debits <> credits THEN
    RAISE EXCEPTION 'journal entry % does not balance: % lines, debits %, credits %', entry, lines, debits, credits
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entries_balance';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER journal_entries_balance
  AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.journal_entry_balances();
CREATE CONSTRAINT TRIGGER journal_lines_balance
  AFTER INSERT ON journal_lines DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.journal_entry_balances();

-- A line is written with its entry, in the same transaction, by the
-- application role: an entry once kept is not added to. A restore, on the
-- control plane, writes the entries it carries as they were.
CREATE FUNCTION app.journal_lines_with_their_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'palugada_app' AND NOT EXISTS (
    SELECT 1 FROM journal_entries WHERE id = NEW.entry_id AND created_at = now()
  ) THEN
    RAISE EXCEPTION 'a line is written with its entry; entry % was kept before this', NEW.entry_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_lines_with_their_entry';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER journal_lines_with_their_entry
  BEFORE INSERT ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION app.journal_lines_with_their_entry();
