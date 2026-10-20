-- The company's invoices, kept in its books (STATUS 2.154).
--
-- `invoice.issue` was catalogued and bound to an accounting service nobody had
-- connected, so the bookkeeper was told to issue invoices and had nowhere to
-- issue them. The platform now keeps them beside the books of 0119: an
-- invoice is written with the entry that puts what is owed in the books, is
-- never rewritten, and is paid or voided by entries of its own. What is owed
-- is read from those entries, so reversing a payment in the books puts the
-- debt back. An accounting service the owner connects still takes the names
-- over (`fallback` in src/broker/registry.ts).

-- Gapless numbering: one counter a company, taken in the transaction that
-- writes the invoice, so a refused invoice uses no number and two issued at
-- once cannot share one.
CREATE TABLE invoice_numbers (
  company_id   uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  last_number  integer NOT NULL DEFAULT 0 CHECK (last_number >= 0)
);
SELECT app.enable_tenant_rls('invoice_numbers');

CREATE TABLE invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  number          text NOT NULL,
  -- The customer's record, when there is one; the name and address below are
  -- what the invoice said when it was issued, whatever the record says now.
  contact_id      uuid,
  customer_name   text NOT NULL,
  customer_email  text,
  issue_date      date NOT NULL,
  due_date        date NOT NULL,
  currency        text NOT NULL,
  subtotal_cents  bigint NOT NULL,
  tax_rate_bps    integer NOT NULL DEFAULT 0,
  tax_cents       bigint NOT NULL DEFAULT 0,
  total_cents     bigint NOT NULL,
  note            text,
  -- The entry that put what is owed in the books. Voiding is the reversal of
  -- it, which is how an invoice is known to be void.
  entry_id        uuid NOT NULL,
  written_by      text NOT NULL,
  task_id         uuid,
  -- Written by work that had read content from outside (F8.9): its words are
  -- read back as data.
  outside         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoices_company_scoped_key UNIQUE (company_id, id),
  CONSTRAINT invoices_one_number UNIQUE (company_id, number),
  CONSTRAINT invoices_contact_fkey
    FOREIGN KEY (company_id, contact_id) REFERENCES contacts (company_id, id) ON DELETE SET NULL (contact_id),
  CONSTRAINT invoices_entry_fkey
    FOREIGN KEY (company_id, entry_id) REFERENCES journal_entries (company_id, id),
  CONSTRAINT invoices_task_fkey
    FOREIGN KEY (company_id, task_id) REFERENCES tasks (company_id, id) ON DELETE SET NULL (task_id),
  CONSTRAINT invoices_number_shape CHECK (number ~ '^INV-[0-9]{4,9}$'),
  CONSTRAINT invoices_name_shape CHECK (length(btrim(customer_name)) BETWEEN 1 AND 200),
  CONSTRAINT invoices_email_shape CHECK (customer_email IS NULL
    OR (length(customer_email) <= 254 AND customer_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  CONSTRAINT invoices_note_bounded CHECK (note IS NULL OR length(note) <= 2000),
  CONSTRAINT invoices_currency_shape CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT invoices_due_after_issue CHECK (due_date >= issue_date),
  CONSTRAINT invoices_tax_rate_range CHECK (tax_rate_bps BETWEEN 0 AND 10000),
  CONSTRAINT invoices_amounts_sane CHECK (
    subtotal_cents > 0 AND tax_cents >= 0 AND total_cents <= 100000000000000),
  -- The figures hold together whatever wrote them.
  CONSTRAINT invoices_total_adds_up CHECK (total_cents = subtotal_cents + tax_cents),
  CONSTRAINT invoices_writer_known CHECK (written_by IN ('owner', 'agent'))
);
CREATE INDEX invoices_by_date ON invoices (company_id, created_at DESC);
CREATE INDEX invoices_by_contact ON invoices (company_id, contact_id) WHERE contact_id IS NOT NULL;
SELECT app.enable_tenant_rls('invoices');
-- Never rewritten: paid and voided by entries, not by editing the invoice.
REVOKE UPDATE ON invoices FROM palugada_app;

CREATE TABLE invoice_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  invoice_id      uuid NOT NULL,
  position        smallint NOT NULL,
  description     text NOT NULL,
  -- Thousandths, so 2.5 hours is 2500 and no figure is a float.
  quantity_milli  bigint NOT NULL,
  unit_cents      bigint NOT NULL,
  amount_cents    bigint NOT NULL,
  CONSTRAINT invoice_lines_company_scoped_key UNIQUE (company_id, id),
  CONSTRAINT invoice_lines_invoice_fkey
    FOREIGN KEY (company_id, invoice_id) REFERENCES invoices (company_id, id) ON DELETE CASCADE,
  CONSTRAINT invoice_lines_one_position UNIQUE (invoice_id, position),
  CONSTRAINT invoice_lines_description_shape CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  CONSTRAINT invoice_lines_figures CHECK (quantity_milli > 0 AND unit_cents >= 0 AND amount_cents >= 0)
);
SELECT app.enable_tenant_rls('invoice_lines');
REVOKE UPDATE ON invoice_lines FROM palugada_app;

CREATE TABLE invoice_payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  invoice_id    uuid NOT NULL,
  paid_on       date NOT NULL,
  amount_cents  bigint NOT NULL,
  -- The entry that took it into the books. A payment whose entry was
  -- reversed no longer counts.
  entry_id      uuid NOT NULL,
  written_by    text NOT NULL,
  task_id       uuid,
  outside       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoice_payments_company_scoped_key UNIQUE (company_id, id),
  CONSTRAINT invoice_payments_invoice_fkey
    FOREIGN KEY (company_id, invoice_id) REFERENCES invoices (company_id, id) ON DELETE CASCADE,
  CONSTRAINT invoice_payments_entry_fkey
    FOREIGN KEY (company_id, entry_id) REFERENCES journal_entries (company_id, id),
  CONSTRAINT invoice_payments_task_fkey
    FOREIGN KEY (company_id, task_id) REFERENCES tasks (company_id, id) ON DELETE SET NULL (task_id),
  CONSTRAINT invoice_payments_one_entry UNIQUE (company_id, entry_id),
  CONSTRAINT invoice_payments_positive CHECK (amount_cents > 0 AND amount_cents <= 100000000000000),
  CONSTRAINT invoice_payments_writer_known CHECK (written_by IN ('owner', 'agent'))
);
CREATE INDEX invoice_payments_of_invoice ON invoice_payments (invoice_id);
SELECT app.enable_tenant_rls('invoice_payments');
REVOKE UPDATE ON invoice_payments FROM palugada_app;
