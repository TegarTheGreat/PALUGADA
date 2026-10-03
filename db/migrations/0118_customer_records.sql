-- The company's own customer records (STATUS 2.138).
--
-- `crm.read` and `crm.note` were catalogued from the start and bound to
-- nothing, so the roles told to keep the customer record had none, and what
-- a customer was told lived in a run's output. The platform now keeps one:
-- the people the company deals with, what it noted about them, and the
-- deals it has with them. A CRM the owner connects still takes the names
-- over (`fallback` in src/broker/registry.ts).

CREATE TABLE contacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- As the owner or a run wrote it, or as the customer named themselves to
  -- the channel they first wrote on: a stranger's words, read as data.
  name          text NOT NULL,
  organisation  text,
  email         text,
  phone         text,
  -- Who made the record: the owner, a run, or a customer's first message.
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- Out of the list and out of what runs find; kept, since its
  -- conversations and deals still name it.
  archived_at   timestamptz,
  CONSTRAINT contacts_company_scoped_key UNIQUE (company_id, id),
  CONSTRAINT contacts_name_shape CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT contacts_organisation_bounded CHECK (length(organisation) <= 200),
  CONSTRAINT contacts_email_shape CHECK (email IS NULL OR (length(email) <= 254 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  CONSTRAINT contacts_phone_shape CHECK (phone IS NULL OR phone ~ '^\+?[0-9][0-9 ()-]{5,30}$'),
  CONSTRAINT contacts_made_by_known CHECK (created_by IN ('owner', 'agent', 'chat'))
);

CREATE INDEX contacts_recent ON contacts (company_id, updated_at DESC);
-- What a message is matched by: the address, whatever its case, and the
-- number's digits.
CREATE INDEX contacts_by_email ON contacts (company_id, lower(email)) WHERE email IS NOT NULL;
CREATE INDEX contacts_by_phone ON contacts (company_id, regexp_replace(phone, '\D', '', 'g')) WHERE phone IS NOT NULL;
SELECT app.enable_tenant_rls('contacts');

-- What the company noted about someone: kept as written. The application
-- role adds a note and never rewrites one.
CREATE TABLE contact_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contact_id  uuid NOT NULL,
  body        text NOT NULL,
  written_by  text NOT NULL,
  -- The work that wrote it; null for the owner's.
  task_id     uuid,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT contact_notes_company_scoped_key UNIQUE (company_id, id),
  CONSTRAINT contact_notes_contact_fkey
    FOREIGN KEY (company_id, contact_id) REFERENCES contacts (company_id, id) ON DELETE CASCADE,
  CONSTRAINT contact_notes_task_fkey
    FOREIGN KEY (company_id, task_id) REFERENCES tasks (company_id, id) ON DELETE SET NULL (task_id),
  CONSTRAINT contact_notes_body_shape CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
  CONSTRAINT contact_notes_writer_known CHECK (written_by IN ('owner', 'agent'))
);

CREATE INDEX contact_notes_of_contact ON contact_notes (contact_id, created_at DESC);
SELECT app.enable_tenant_rls('contact_notes');
REVOKE UPDATE ON contact_notes FROM palugada_app;

-- What the company hopes to sell someone, and how far it got.
CREATE TABLE deals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contact_id   uuid NOT NULL,
  title        text NOT NULL,
  stage        text NOT NULL DEFAULT 'lead',
  -- What it is worth, in the smallest unit of its currency, or not said.
  value_cents  bigint,
  currency     text,
  expected_on  date,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- When it was won or lost; null while it is open.
  closed_at    timestamptz,
  CONSTRAINT deals_company_scoped_key UNIQUE (company_id, id),
  CONSTRAINT deals_contact_fkey
    FOREIGN KEY (company_id, contact_id) REFERENCES contacts (company_id, id) ON DELETE CASCADE,
  CONSTRAINT deals_title_shape CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT deals_stage_known CHECK (stage IN ('lead', 'qualified', 'proposal', 'won', 'lost')),
  CONSTRAINT deals_value_with_currency CHECK ((value_cents IS NULL) = (currency IS NULL)),
  CONSTRAINT deals_value_sane CHECK (value_cents IS NULL OR value_cents BETWEEN 0 AND 100000000000000),
  CONSTRAINT deals_currency_shape CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  CONSTRAINT deals_closed_when_decided CHECK ((closed_at IS NOT NULL) = (stage IN ('won', 'lost'))),
  CONSTRAINT deals_made_by_known CHECK (created_by IN ('owner', 'agent'))
);

CREATE INDEX deals_of_contact ON deals (contact_id, updated_at DESC);
SELECT app.enable_tenant_rls('deals');

-- The customer a conversation is with. Set when the conversation starts,
-- from the address or number the owner already keeps, or a new record.
--
-- Adding the key reads every conversation as the table's owner, which
-- forced row security refuses without a tenant: lifted for this transaction
-- on the two tables the key joins, and put back before it ends (as 0049).
ALTER TABLE chats NO FORCE ROW LEVEL SECURITY;
ALTER TABLE contacts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE chats
  ADD COLUMN contact_id uuid,
  ADD CONSTRAINT chats_contact_fkey
    FOREIGN KEY (company_id, contact_id) REFERENCES contacts (company_id, id) ON DELETE SET NULL (contact_id);
ALTER TABLE chats FORCE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
CREATE INDEX chats_of_contact ON chats (contact_id) WHERE contact_id IS NOT NULL;
