-- Issues, to-dos and postmortems are tickets (F18.4, F18.5).
--
-- A company of agents reported problems -- an incident card, an escalation
-- that told the coordinator to "fix the cause" in free text -- and solved
-- none of them on the record. There was no place where a problem was given a
-- root cause and a decision, nothing that carried the decision out, and
-- nothing the company learned from a failure: lessons were kept only from
-- work that completed.
--
-- An issue is a ticket of kind `issue`: a problem to solve, never work to
-- hand out. It is solved by naming its root cause and the decision taken
-- (`closed_reason`), and the decision is carried out by to-dos: work tickets
-- that name the issue they solve, each with one seat and a due date. They are
-- tickets rather than a new inbox kind, because the owner's inbox is for the
-- owner's decisions (F10.1), and rather than tables of their own, because the
-- board, its row security, its export and its history already exist.

-- Adding the constraints below reads every company's tickets as the table's
-- owner, which forced row security refuses without a tenant: lifted for
-- this transaction, and put back before it ends (as 0134).
ALTER TABLE tickets NO FORCE ROW LEVEL SECURITY;
ALTER TABLE goals NO FORCE ROW LEVEL SECURITY;
ALTER TABLE goal_metrics NO FORCE ROW LEVEL SECURITY;
ALTER TABLE inbox_items NO FORCE ROW LEVEL SECURITY;
ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;

ALTER TABLE tickets DROP CONSTRAINT tickets_kind_known;
ALTER TABLE tickets ADD CONSTRAINT tickets_kind_known CHECK (kind IN ('work', 'hire', 'issue'));

-- The platform files an issue itself when work fails with a cause worth
-- finding (a postmortem), and later when a number goes off track. It is not
-- the owner and it is not a run, so it says so: `platform`, with the task the
-- failure was about, when there is one, as the task the ticket exists for.
ALTER TABLE tickets DROP CONSTRAINT tickets_opened_by_known;
ALTER TABLE tickets ADD CONSTRAINT tickets_opened_by_known CHECK (opened_by IN ('owner', 'agent', 'platform'));
ALTER TABLE tickets DROP CONSTRAINT tickets_agent_has_task;
ALTER TABLE tickets ADD CONSTRAINT tickets_agent_has_task CHECK (opened_by <> 'agent' OR opened_by_task_id IS NOT NULL);

ALTER TABLE tickets
  -- What the issue is about, when it is about a goal or a number.
  ADD COLUMN goal_id uuid,
  ADD COLUMN metric_id uuid,
  -- `now` is the weekly list; `long_term` is the list read at quarterly planning.
  ADD COLUMN horizon text NOT NULL DEFAULT 'now',
  -- Why it happened, found by asking why of each answer and checking it
  -- against the record. With `closed_reason` as the decision, what makes an
  -- issue solved.
  ADD COLUMN root_cause text,
  -- The incident or escalation the platform filed it from.
  ADD COLUMN from_inbox_item_id uuid,
  -- On a to-do: the issue whose decision it carries out.
  ADD COLUMN solves_ticket_id uuid,
  -- On a to-do: its one seat, and the day it is due.
  ADD COLUMN assignee_role_id uuid,
  ADD COLUMN due_on date,
  -- What filed it, for an issue the platform files: the same source still
  -- open is the same issue (a crash loop in one seat, a number off track).
  ADD COLUMN source_key text,
  ADD CONSTRAINT tickets_goal_fkey FOREIGN KEY (company_id, goal_id)
    REFERENCES goals (company_id, id) ON DELETE SET NULL (goal_id),
  ADD CONSTRAINT tickets_metric_fkey FOREIGN KEY (company_id, metric_id)
    REFERENCES goal_metrics (company_id, id) ON DELETE SET NULL (metric_id),
  ADD CONSTRAINT tickets_from_inbox_item_fkey FOREIGN KEY (company_id, from_inbox_item_id)
    REFERENCES inbox_items (company_id, id) ON DELETE SET NULL (from_inbox_item_id),
  ADD CONSTRAINT tickets_solves_ticket_fkey FOREIGN KEY (company_id, solves_ticket_id)
    REFERENCES tickets (company_id, id) ON DELETE SET NULL (solves_ticket_id),
  ADD CONSTRAINT tickets_assignee_role_fkey FOREIGN KEY (company_id, assignee_role_id)
    REFERENCES roles (company_id, id) ON DELETE SET NULL (assignee_role_id),
  ADD CONSTRAINT tickets_horizon_known CHECK (horizon IN ('now', 'long_term')),
  ADD CONSTRAINT tickets_root_cause_size CHECK (length(root_cause) <= 2000),
  ADD CONSTRAINT tickets_source_key_shape CHECK (source_key IS NULL OR length(btrim(source_key)) BETWEEN 1 AND 200),
  -- An issue is done only with its root cause and its decision. Closed
  -- without them, it was dropped, not solved.
  ADD CONSTRAINT tickets_issue_solved CHECK (
    kind <> 'issue' OR status <> 'done'
    OR (length(btrim(coalesce(root_cause, ''))) > 0 AND length(btrim(coalesce(closed_reason, ''))) > 0)),
  -- Only work carries an issue's decision out, and only work has a seat and
  -- a date: an issue is solved, a hire is the owner's.
  ADD CONSTRAINT tickets_only_work_solves CHECK (solves_ticket_id IS NULL OR kind = 'work'),
  ADD CONSTRAINT tickets_only_work_is_assigned CHECK (kind = 'work' OR (assignee_role_id IS NULL AND due_on IS NULL)),
  ADD CONSTRAINT tickets_source_is_issue CHECK (source_key IS NULL OR kind = 'issue');

ALTER TABLE tickets FORCE ROW LEVEL SECURITY;
ALTER TABLE goals FORCE ROW LEVEL SECURITY;
ALTER TABLE goal_metrics FORCE ROW LEVEL SECURITY;
ALTER TABLE inbox_items FORCE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;

-- The issues list, the to-dos, and the board's filters read by kind.
CREATE INDEX tickets_by_kind ON tickets (company_id, kind, status);
-- An issue found again by what filed it, and the to-dos found by the issue they solve.
CREATE INDEX tickets_source ON tickets (company_id, source_key) WHERE source_key IS NOT NULL;
CREATE INDEX tickets_solves ON tickets (company_id, solves_ticket_id) WHERE solves_ticket_id IS NOT NULL;

-- Solving writes the root cause on the issue it closes. Nothing else that is
-- new may change once a ticket is filed: what an issue is about, where it
-- came from, which issue a to-do solves, its seat and its date are said once.
GRANT UPDATE (root_cause) ON tickets TO palugada_app;
