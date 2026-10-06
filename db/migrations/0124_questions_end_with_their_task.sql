-- A question an agent asked ends with the task that asked it.
--
-- 0036 withdrew an approval when its task ended some other way, and left every
-- other kind: an escalation or an incident about a task is usually *why* it
-- ended, and withdrawing it then would hide what the owner needs to read. An
-- agent's own question (`owner.ask`, `browser.handover`, a request for a key) is
-- the other case. It exists to unblock one task parked in `waiting_approval`;
-- when that task is cancelled, stopped or finished some other way the question
-- stays open in the inbox -- with no expiry, so for ever -- asking for an answer
-- nobody can use (the audit of 6 October, S3). It is the same defect 0036 fixed
-- for approvals, and the same trigger fixes it.
--
-- A coordinator's escalation is not an agent's question (`askedBy` is not
-- 'agent' on it) and is left as it was. The timeline says what happened in the
-- same words as for an approval: the item was withdrawn, and why.
CREATE OR REPLACE FUNCTION app.withdraw_orphaned_approvals() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  WITH withdrawn AS (
    UPDATE inbox_items
       SET status = 'withdrawn',
           closed_reason = 'task_' || NEW.status
     WHERE task_id = NEW.id
       AND company_id = NEW.company_id
       AND status = 'open'
       AND (kind = 'approval'
            OR (kind = 'escalation' AND payload->>'askedBy' = 'agent'))
    RETURNING id
  )
  INSERT INTO events (company_id, project_id, task_id, type, actor, payload)
  SELECT NEW.company_id, NEW.project_id, NEW.id, 'approval.withdrawn', 'system',
         jsonb_build_object('inboxItemId', withdrawn.id, 'taskStatus', NEW.status)
    FROM withdrawn;
  RETURN NULL;
END $$;
