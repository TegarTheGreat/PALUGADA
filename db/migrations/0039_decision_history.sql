-- ---------------------------------------------------------------------------
-- A decision the owner made can be found again (PRD v2 F10.8)
--
-- Slack's most repeated complaint is not about sending: it is that a decision
-- made in a thread cannot be found a month later, because the thread scrolled
-- away and search matches words rather than what was decided. This platform
-- avoided the first half by design -- a decision is a structured row, not a
-- message -- and then reproduced the second: the console showed open items
-- and nothing else, so a decided one left the only screen the owner has. The
-- record was in the event log, which is an audit trail, not something a
-- person searches.
--
-- `decided_via` records which surface the answer came from. It was in the
-- `owner.decided` event's payload and nowhere a list could read without
-- joining the log item by item, and "did I approve that from my phone" is
-- the first question a history answers.
-- ---------------------------------------------------------------------------

ALTER TABLE inbox_items
  ADD COLUMN decided_via text
  CONSTRAINT inbox_decided_via_known CHECK (decided_via IS NULL OR decided_via IN ('app', 'chat', 'api'));

-- The history reads closed items newest first, a page at a time, keyed on
-- (created_at, id) so a page boundary is stable while new items close.
CREATE INDEX inbox_history_idx
  ON inbox_items (company_id, created_at DESC, id DESC)
  WHERE status <> 'open';
