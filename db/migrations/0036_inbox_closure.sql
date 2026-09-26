-- ---------------------------------------------------------------------------
-- An inbox item ends when its question does (PRD v2 F10.4, F10.7, F10.9)
--
-- Two gaps, one idea: what the owner is shown must stop asking once there is
-- nothing left to answer.
--
-- **An approval outlived its task.** An approval exists to unblock one task
-- sitting in `waiting_approval`. When that task ended some other way -- the
-- owner pressed "cancel everything", a containment rule halted it, a sibling's
-- failure cancelled the tree -- the approval stayed `open`, in the inbox and in
-- every chat it had been sent to, asking for consent to something that could
-- no longer happen. Pressing "approve" then recorded a decision against a
-- cancelled task and failed half-way through moving it, which left the audit
-- log saying the owner approved work that never ran.
--
-- The rule lives in a trigger rather than in `transition()` because not every
-- path goes through `transition()`: F10.7's stop button is a bulk UPDATE, and
-- it has to be -- one statement is what makes it a stop rather than a loop
-- that a crash can interrupt half-way. A rule the bulk path can skip is the
-- rule that is missing on the one afternoon it matters.
--
-- Only `approval`. An escalation or an incident about a task is usually *why*
-- the task ended, and withdrawing it at that moment would hide exactly the
-- item the owner needs to read.
--
-- **A delivered message outlived its item.** `external_ref` was kept "so a
-- later edit or deletion can find it", and nothing ever edited. So a chat
-- message kept its Approve/Deny buttons after the owner had decided in the
-- console, after the item expired, after the task was cancelled -- Slack's
-- best-known human-in-the-loop defect, where a stale button is one tap from a
-- decision nobody meant to make. `retracted_at` is the exactly-once record for
-- the edit, the same way `delivered_at` is for the send.
-- ---------------------------------------------------------------------------

ALTER TABLE inbox_items DROP CONSTRAINT inbox_status_known;
ALTER TABLE inbox_items ADD CONSTRAINT inbox_status_known
  CHECK (status IN ('open', 'decided', 'expired', 'withdrawn'));

-- Why an item closed without the owner deciding it. NULL for a decision,
-- which carries its own reason in `decision` and `owner_note`.
ALTER TABLE inbox_items ADD COLUMN closed_reason text;
ALTER TABLE inbox_items ADD CONSTRAINT inbox_withdrawn_has_reason
  CHECK (status <> 'withdrawn' OR closed_reason IS NOT NULL);

CREATE OR REPLACE FUNCTION app.withdraw_orphaned_approvals() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- The event rows are written by the same statement that closes the items,
  -- so there is no window in which an approval is closed and the timeline
  -- does not say why.
  WITH withdrawn AS (
    UPDATE inbox_items
       SET status = 'withdrawn',
           closed_reason = 'task_' || NEW.status
     WHERE task_id = NEW.id
       AND company_id = NEW.company_id
       AND status = 'open'
       AND kind = 'approval'
    RETURNING id
  )
  INSERT INTO events (company_id, project_id, task_id, type, actor, payload)
  SELECT NEW.company_id, NEW.project_id, NEW.id, 'approval.withdrawn', 'system',
         jsonb_build_object('inboxItemId', withdrawn.id, 'taskStatus', NEW.status)
    FROM withdrawn;
  RETURN NULL;
END $$;

-- AFTER, and only on the edge into a terminal status: a task moving between
-- two live states still has a question pending, and one already terminal has
-- nothing left to withdraw.
CREATE TRIGGER tasks_withdraw_orphaned_approvals
  AFTER UPDATE OF status ON tasks
  FOR EACH ROW
  WHEN (NEW.status IN ('completed', 'failed', 'halted', 'cancelled')
        AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION app.withdraw_orphaned_approvals();

-- The edit that tells a chat the item is closed. Bounded like the send: a
-- transport that cannot edit should stop being asked rather than turn every
-- tick into a failed call.
ALTER TABLE owner_notifications
  ADD COLUMN retracted_at timestamptz,
  ADD COLUMN retract_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN retract_error text;

-- The sweep reads exactly this: delivered, not yet retracted.
CREATE INDEX owner_notifications_unretracted_idx
  ON owner_notifications (company_id, channel)
  WHERE delivered_at IS NOT NULL AND retracted_at IS NULL AND inbox_item_id IS NOT NULL;
