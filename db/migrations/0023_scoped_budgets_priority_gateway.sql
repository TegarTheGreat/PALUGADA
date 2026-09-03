-- ---------------------------------------------------------------------------
-- Scoped budgets, task priority, division escalation, config rollback, and
-- the runtime gateway (PRD v2 F1.6, F5.10, F2.1, F3.9, F12.7, F12.8, F12.10)
--
-- Five small additions that share a migration because each is a column or a
-- narrow table, and separate files would suggest they were staged rather than
-- simply written on the same day.
-- ---------------------------------------------------------------------------

-- F1.6: a budget account belongs to a scope, and a scope inherits from the one
-- above it. `parent_account_id` is the inheritance: a division's ceiling is its
-- own *and* every ancestor's, so raising a division's limit cannot raise the
-- company's. The reservation path already walks parents; what was missing was
-- anything for it to walk.
ALTER TABLE budget_accounts
  ADD COLUMN scope_type text NOT NULL DEFAULT 'company',
  ADD COLUMN scope_id uuid,
  ADD COLUMN parent_account_id uuid REFERENCES budget_accounts(id) ON DELETE CASCADE;

ALTER TABLE budget_accounts
  ADD CONSTRAINT budget_scope_known
    CHECK (scope_type IN ('company', 'project', 'division', 'role')),
  -- A company account is the root and has no parent; everything narrower does.
  -- Without this a division account could be created detached, and its spending
  -- would count against nothing.
  ADD CONSTRAINT budget_scope_names_a_subject
    CHECK ((scope_type = 'company') = (scope_id IS NULL)),
  ADD CONSTRAINT budget_narrow_scope_has_a_parent
    CHECK ((scope_type = 'company') = (parent_account_id IS NULL));

CREATE INDEX budget_accounts_scope_idx
  ON budget_accounts (company_id, scope_type, scope_id);

-- F5.10: P0 is an incident, P3 is whenever. Default P2, which is what almost
-- everything is: work that should happen today and does not need to jump a
-- queue. Stored as a number so ordering is ordering rather than a CASE.
ALTER TABLE tasks ADD COLUMN priority smallint NOT NULL DEFAULT 2;
ALTER TABLE tasks ADD CONSTRAINT tasks_priority_range CHECK (priority BETWEEN 0 AND 3);
CREATE INDEX tasks_claimable_by_priority_idx
  ON tasks (company_id, status, priority, created_at)
  WHERE status = 'pending';

ALTER TABLE schedules ADD COLUMN priority smallint NOT NULL DEFAULT 2;
ALTER TABLE schedules ADD CONSTRAINT schedules_priority_range CHECK (priority BETWEEN 0 AND 3);

-- F2.1: a division's escalation policy. Which role hears about a problem, and
-- how long the division may sit on one before the owner does. NULL means the
-- company default, so a division that has never thought about it behaves like
-- everything else rather than like nothing.
ALTER TABLE divisions
  ADD COLUMN escalation_role_slug text,
  ADD COLUMN escalate_after_minutes integer;
ALTER TABLE divisions
  ADD CONSTRAINT divisions_escalation_delay_positive
    CHECK (escalate_after_minutes IS NULL OR escalate_after_minutes > 0);

-- ---------------------------------------------------------------------------
-- F3.9: every config change is a version, and any version can be restored.
--
-- One table for all of them rather than a history table per kind. The reason is
-- the requirement itself: "rollback to any version in one click" is a single
-- operation, and an operation that has to know six table shapes is six
-- operations wearing one name.
--
-- The snapshot is the *whole* value rather than a diff. Restoring from diffs
-- means replaying a chain, and a chain with one bad link cannot be replayed at
-- all -- which is precisely the situation somebody is in when they reach for
-- rollback.
-- ---------------------------------------------------------------------------
CREATE TABLE config_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  subject_id  uuid,
  version     integer NOT NULL,
  snapshot    jsonb NOT NULL,
  summary     text NOT NULL DEFAULT '',
  changed_by  text NOT NULL DEFAULT 'owner',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, kind, subject_id, version),
  CONSTRAINT config_kind_known
    CHECK (kind IN ('charter', 'policy', 'role', 'grant', 'bundle', 'skill'))
);
SELECT app.enable_tenant_rls('config_versions');
CREATE INDEX config_versions_subject_idx
  ON config_versions (company_id, kind, subject_id, version DESC);

-- ---------------------------------------------------------------------------
-- F12.7, F12.8, F12.10: the gateway a runtime connects through.
--
-- A runtime is a device with an identity. A new one is paired by the owner
-- before it may do anything, and it proves it is itself by signing a nonce the
-- gateway issued -- so a stolen device id is not a working device.
--
-- The dedupe cache is F12.8. Every adapter method with a side effect carries an
-- idempotency key, and the gateway remembers the answer it gave. A retried call
-- gets the first answer rather than a second effect, which is what makes an
-- at-least-once transport safe to put in front of an external action.
-- ---------------------------------------------------------------------------
CREATE TABLE gateway_devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name          text NOT NULL,
  runtime       text NOT NULL,
  -- The device's public key, in whatever form its algorithm uses. Never a
  -- shared secret: a gateway that stores something it could impersonate the
  -- device with is a gateway whose compromise is the device's compromise.
  public_key    text NOT NULL,
  status        text NOT NULL DEFAULT 'pending',
  -- F12.10: an unsigned bundle, or a device the owner has not vouched for,
  -- runs in quarantine -- tier 0 only, which is to say it may read and may not
  -- change anything.
  quarantined   boolean NOT NULL DEFAULT true,
  paired_at     timestamptz,
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name),
  CONSTRAINT gateway_device_status_known
    CHECK (status IN ('pending', 'paired', 'revoked')),
  CONSTRAINT gateway_paired_has_a_time
    CHECK ((status = 'paired') = (paired_at IS NOT NULL))
);
SELECT app.enable_tenant_rls('gateway_devices');

CREATE TABLE gateway_challenges (
  nonce       text PRIMARY KEY,
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  device_id   uuid NOT NULL REFERENCES gateway_devices(id) ON DELETE CASCADE,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  -- Consumed rather than deleted, so a replayed signature is refused with a
  -- reason rather than treated as a nonce nobody has seen.
  consumed_at timestamptz
);
SELECT app.enable_tenant_rls('gateway_challenges');
CREATE INDEX gateway_challenges_device_idx ON gateway_challenges (device_id, expires_at);

CREATE TABLE gateway_dedupe (
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  device_id       uuid NOT NULL REFERENCES gateway_devices(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  method          text NOT NULL,
  response        jsonb,
  status          text NOT NULL DEFAULT 'in_flight',
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, idempotency_key),
  CONSTRAINT gateway_dedupe_status_known
    CHECK (status IN ('in_flight', 'settled', 'failed'))
);
SELECT app.enable_tenant_rls('gateway_dedupe');
