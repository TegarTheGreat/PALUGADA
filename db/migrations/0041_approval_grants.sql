-- ---------------------------------------------------------------------------
-- An approval the owner gave is one the broker can find (PRD v2 F10, F8.3)
--
-- The broker asked for owner approval by raising an inbox item and throwing
-- `approval.required`; `decide` then moved the task back to `running`. The
-- run started again, reached the same capability, found no *open* item --
-- the owner had just closed it -- raised a new one and parked the task again.
-- Nothing anywhere asked "has the owner already said yes to this?", so an
-- approved tier 3 action never ran: every approval produced another request
-- for approval. The acceptance tests checked that approving moved the task to
-- `running`, and never that the action then happened.
--
-- So an approval records *which action* it is for -- the same fingerprint the
-- review gate uses, a hash of the capability and its input -- and when it was
-- used. The broker proceeds on a decided, approved, unused item for this task
-- and this exact action, and marks it used once the action has executed:
-- approving "wire 500 to Acme" does not authorise "wire 5,000 to Acme", and
-- does not authorise the same wire twice.
-- ---------------------------------------------------------------------------

ALTER TABLE inbox_items
  ADD COLUMN action_fingerprint text,
  ADD COLUMN consumed_at timestamptz;

ALTER TABLE inbox_items ADD CONSTRAINT inbox_consumed_only_when_approved
  CHECK (consumed_at IS NULL OR (kind = 'approval' AND decision = 'approve'));

CREATE INDEX inbox_granted_approval_idx
  ON inbox_items (task_id, capability_name, action_fingerprint)
  WHERE kind = 'approval' AND status = 'decided' AND decision = 'approve'
    AND consumed_at IS NULL;
