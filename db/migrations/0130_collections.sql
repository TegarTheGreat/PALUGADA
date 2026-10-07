-- Collecting what customers owe, by the platform (STATUS 2.178; the owner's
-- request of 7 October: white-collar work handled, and automatically).
--
-- An invoice past its due date is reminded three days late, then ten, then
-- twenty-four, in a letter the platform writes from the books alone
-- (src/records/collections.ts). Three small things are kept:
--
--   - the company's policy: whether it reminds at all, on which days, and the
--     owner's words on how to pay, which the letters carry and nothing else
--     of the owner's;
--   - each letter that went, once: a step of an invoice is written a single
--     time whoever asks again (the capability holds a lock on the invoice
--     from reading what was sent to writing what it sent);
--   - an invoice the owner asked to leave alone, and whether a person was
--     told that it is still unpaid after the last letter (told once).

CREATE TABLE collections_policy (
  company_id    uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  -- On by default: the owner switches it off, not on. A company with no
  -- invoices, or with no role that sends them, has nothing for it to do.
  enabled       boolean NOT NULL DEFAULT true,
  -- Days past the due date at which each letter goes: one to five, rising.
  steps_days    smallint[] NOT NULL DEFAULT '{3,10,24}',
  -- Where to pay, in the owner's words; empty is not made up for them.
  payment_note  text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT collections_policy_steps_shape CHECK (
    cardinality(steps_days) BETWEEN 1 AND 5
    AND array_position(steps_days, NULL) IS NULL
    AND steps_days[1] BETWEEN 1 AND 180
    AND steps_days[cardinality(steps_days)] BETWEEN 1 AND 180
    AND (cardinality(steps_days) < 2 OR steps_days[1] < steps_days[2])
    AND (cardinality(steps_days) < 3 OR steps_days[2] < steps_days[3])
    AND (cardinality(steps_days) < 4 OR steps_days[3] < steps_days[4])
    AND (cardinality(steps_days) < 5 OR steps_days[4] < steps_days[5])),
  CONSTRAINT collections_policy_note_bounded CHECK (payment_note IS NULL OR length(payment_note) <= 500)
);
SELECT app.enable_tenant_rls('collections_policy');

CREATE TABLE invoice_reminders (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  invoice_id         uuid NOT NULL,
  -- Which letter: 1 is the first. An invoice has each once.
  step               smallint NOT NULL,
  -- The day it was sent, in UTC, which is the day the steps are counted from.
  sent_on            date NOT NULL,
  sent_at            timestamptz NOT NULL DEFAULT now(),
  to_address         text NOT NULL,
  message_id         text,
  -- What the books said when it was written, so the letter can be read again.
  outstanding_cents  bigint NOT NULL,
  days_overdue       integer NOT NULL,
  task_id            uuid,
  CONSTRAINT invoice_reminders_company_scoped_key UNIQUE (company_id, id),
  CONSTRAINT invoice_reminders_one_per_step UNIQUE (invoice_id, step),
  CONSTRAINT invoice_reminders_invoice_fkey
    FOREIGN KEY (company_id, invoice_id) REFERENCES invoices (company_id, id) ON DELETE CASCADE,
  CONSTRAINT invoice_reminders_task_fkey
    FOREIGN KEY (company_id, task_id) REFERENCES tasks (company_id, id) ON DELETE SET NULL (task_id),
  CONSTRAINT invoice_reminders_step_range CHECK (step BETWEEN 1 AND 5),
  CONSTRAINT invoice_reminders_amount_positive CHECK (outstanding_cents > 0)
);
CREATE INDEX invoice_reminders_by_invoice ON invoice_reminders (invoice_id, step);
SELECT app.enable_tenant_rls('invoice_reminders');
-- A letter that went is a fact: it is written once and not rewritten.
REVOKE UPDATE ON invoice_reminders FROM palugada_app;

CREATE TABLE invoice_collections (
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  invoice_id    uuid NOT NULL,
  -- The owner asked that this invoice not be reminded: a customer who is
  -- slow for a reason the books do not know.
  held_at       timestamptz,
  -- A person was told this invoice is still unpaid after its letters.
  escalated_at  timestamptz,
  PRIMARY KEY (company_id, invoice_id),
  CONSTRAINT invoice_collections_invoice_fkey
    FOREIGN KEY (company_id, invoice_id) REFERENCES invoices (company_id, id) ON DELETE CASCADE
);
SELECT app.enable_tenant_rls('invoice_collections');
