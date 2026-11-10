-- A write the platform keeps itself is made once for each call (the audit of
-- 10 October, "ledger.record can double-post across the crash gap").
--
-- The engine journals a tool call when the broker answers it. A worker that
-- dies after a capability committed its write and before that answer was
-- kept runs the step again, under the same call key (journal.ts, `callKey`):
-- an entry posted twice is money counted twice, an invoice issued twice is a
-- customer billed twice, a contact kept twice is two of one person. The
-- platform's own writers now keep their answer here, under the call's key, in
-- the transaction that makes the write; a call they answered before is
-- answered the same way and writes nothing (src/broker/once.ts).
--
-- Kept with the work that made the call and gone with it: the retention purge
-- of finished work takes these too, and nothing calls a finished task's step
-- again.
CREATE TABLE call_answers (
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  capability  text NOT NULL,
  call_key    text NOT NULL,
  task_id     uuid NOT NULL,
  answer      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, capability, call_key),
  CONSTRAINT call_answers_task_fkey
    FOREIGN KEY (company_id, task_id) REFERENCES tasks (company_id, id) ON DELETE CASCADE,
  CONSTRAINT call_answers_key_shape CHECK (length(call_key) BETWEEN 1 AND 200),
  CONSTRAINT call_answers_capability_shape CHECK (length(capability) BETWEEN 1 AND 100)
);
CREATE INDEX call_answers_of_task ON call_answers (task_id);
SELECT app.enable_tenant_rls('call_answers');
-- An answer is what was done; it is never rewritten.
REVOKE UPDATE ON call_answers FROM palugada_app;

-- A reminder letter from the moment it is handed to the mail server until the
-- server says it took it (`invoice.remind`).
--
-- A letter cannot be called back, so a reminder is sent at most once. The
-- step is taken here, and committed, before a word goes to the server; when
-- the server says it took the letter, the letter is written to
-- `invoice_reminders` and its row here goes, in one transaction. A server
-- that refused it gives the step back (the row goes, and nothing was sent).
-- What stays here past a few minutes is a letter the server may or may not
-- have taken -- it hung up after the letter and before its answer, or the
-- platform stopped between the two -- and it counts as sent: the owner is
-- told, once, that it was not confirmed, rather than the customer being
-- written to twice.
CREATE TABLE invoice_reminder_attempts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  invoice_id         uuid NOT NULL,
  step               smallint NOT NULL,
  to_address         text NOT NULL,
  -- What the books said when it was written, as `invoice_reminders` keeps it.
  outstanding_cents  bigint NOT NULL,
  days_overdue       integer NOT NULL,
  started_at         timestamptz NOT NULL DEFAULT now(),
  task_id            uuid,
  CONSTRAINT invoice_reminder_attempts_company_scoped_key UNIQUE (company_id, id),
  CONSTRAINT invoice_reminder_attempts_one_per_step UNIQUE (invoice_id, step),
  CONSTRAINT invoice_reminder_attempts_invoice_fkey
    FOREIGN KEY (company_id, invoice_id) REFERENCES invoices (company_id, id) ON DELETE CASCADE,
  CONSTRAINT invoice_reminder_attempts_task_fkey
    FOREIGN KEY (company_id, task_id) REFERENCES tasks (company_id, id) ON DELETE SET NULL (task_id),
  CONSTRAINT invoice_reminder_attempts_step_range CHECK (step BETWEEN 1 AND 5),
  CONSTRAINT invoice_reminder_attempts_amount_positive CHECK (outstanding_cents > 0)
);
SELECT app.enable_tenant_rls('invoice_reminder_attempts');
REVOKE UPDATE ON invoice_reminder_attempts FROM palugada_app;
-- The one table of these the application deletes from: a letter the server
-- took becomes a reminder, and one it refused gives its step back.
GRANT DELETE ON invoice_reminder_attempts TO palugada_app;
