-- ---------------------------------------------------------------------------
-- What the owner has actually been told (PRD v2 F10.5, F10.9)
--
-- Both requirements had been graded "a rule with no transport behind it", and
-- the rule was the harder half — but a transport needs one thing the rule does
-- not, and it is this table. A notifier without a record of what it sent is a
-- notifier that sends the same incident on every tick: the inbox item stays
-- open until the owner decides, and "open and past its notify_after" is true
-- for as long as they take. The first real deployment would have woken its
-- owner every thirty seconds until they answered.
--
-- So delivery is recorded per item *and per channel*. Per channel because the
-- two surfaces answer different questions: F10.5's push is "wake them", F10.9's
-- message channel is "let them act", and an item can legitimately be both — an
-- incident is pushed and also appears in the chat as a link. One row per pair
-- means neither repeats and neither suppresses the other.
--
-- A failed attempt is a row too, with `delivered_at` still NULL and the reason
-- recorded. A push that could not be sent is not the same as one that was not
-- worth sending, and only one of those should be retried.
-- ---------------------------------------------------------------------------

CREATE TABLE owner_notifications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  inbox_item_id  uuid NOT NULL REFERENCES inbox_items(id) ON DELETE CASCADE,
  -- The transport's own name: `push:webhook`, `chat:telegram`. Free text
  -- rather than an enum because the whole point of F10.9 is that the surfaces
  -- are pluggable, and a migration per integration would be a migration
  -- nobody writes.
  channel        text NOT NULL,
  -- What the channel may let the owner do with it (F10.9, F10.10): `actionable`
  -- or `link_only`. Recorded rather than recomputed, because it is the answer
  -- to "why did this arrive without buttons" months later, and by then the
  -- item's tier may have been overridden.
  delivery       text NOT NULL CHECK (delivery IN ('actionable', 'link_only')),
  attempts       integer NOT NULL DEFAULT 0,
  delivered_at   timestamptz,
  -- The transport's id for the message, so a later edit or deletion can find
  -- it: a Telegram message id, a push receipt.
  external_ref   text,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now(),

  -- One attempt row per item per channel. The uniqueness *is* the
  -- no-repeat rule: without it the dispatcher would insert a fresh row on
  -- every tick and the owner's phone would ring until they answered.
  UNIQUE (inbox_item_id, channel)
);

CREATE INDEX owner_notifications_undelivered_idx
  ON owner_notifications (company_id, created_at)
  WHERE delivered_at IS NULL;

ALTER TABLE owner_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_notifications FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON owner_notifications
  USING (company_id = app.current_company_id())
  WITH CHECK (company_id = app.current_company_id());

-- The application role may read and write these: the dispatcher runs beside
-- the worker, in the tenant's own context, and an agent reading which of its
-- escalations reached the owner learns nothing it did not already know.
GRANT SELECT, INSERT, UPDATE ON owner_notifications TO palugada_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON owner_notifications TO palugada_admin;
