-- Tickets: the company's own backlog of work that is owed but not yet given
-- to anyone.
--
-- `ticket.create` was catalogued against an adapter named `tracker` that
-- nothing provided, so on every deployment without a vendor file it was
-- offered to the planner and the support responder, and refused when they
-- used it. The planner's done criteria asked for "the tickets that follow
-- from it", the responder was told to open a ticket when a customer's answer
-- needed someone else -- and those tickets went nowhere, and nobody saw them.
--
-- A ticket is here now, in the company, where the owner sees it and the CEO
-- can read it: something a role or the owner says needs doing, which becomes
-- a task when somebody is given it, and closes itself when that task
-- finishes. A deployment that binds `ticket.create` to an outside tracker in
-- its vendor file still can; the vendor's binding replaces this one.

CREATE TABLE tickets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id          uuid NOT NULL,
  -- Where it belongs; null is the whole company's.
  division_id         uuid,
  title               text NOT NULL,
  body                text NOT NULL DEFAULT '',
  status              text NOT NULL DEFAULT 'open',
  priority            smallint NOT NULL DEFAULT 2,
  opened_by           text NOT NULL,
  -- The task whose run filed it, for "why does this exist".
  opened_by_task_id   uuid,
  -- The task doing it, while one is.
  working_task_id     uuid,
  closed_reason       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  closed_at           timestamptz,
  CONSTRAINT tickets_company_scoped_key UNIQUE (company_id, id),
  CONSTRAINT tickets_project_fkey FOREIGN KEY (company_id, project_id) REFERENCES projects (company_id, id) ON DELETE CASCADE,
  CONSTRAINT tickets_division_fkey FOREIGN KEY (company_id, division_id) REFERENCES divisions (company_id, id) ON DELETE SET NULL (division_id),
  CONSTRAINT tickets_opened_by_task_fkey FOREIGN KEY (company_id, opened_by_task_id) REFERENCES tasks (company_id, id) ON DELETE SET NULL (opened_by_task_id),
  CONSTRAINT tickets_working_task_fkey FOREIGN KEY (company_id, working_task_id) REFERENCES tasks (company_id, id) ON DELETE SET NULL (working_task_id),
  CONSTRAINT tickets_status_known CHECK (status IN ('open', 'in_progress', 'done', 'closed')),
  CONSTRAINT tickets_priority_range CHECK (priority BETWEEN 0 AND 3),
  CONSTRAINT tickets_opened_by_known CHECK (opened_by IN ('owner', 'agent')),
  CONSTRAINT tickets_agent_has_task CHECK (opened_by = 'owner' OR opened_by_task_id IS NOT NULL),
  CONSTRAINT tickets_title_shape CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT tickets_body_size CHECK (length(body) <= 8000),
  CONSTRAINT tickets_closed_when_finished CHECK ((status IN ('done', 'closed')) = (closed_at IS NOT NULL)),
  CONSTRAINT tickets_worked_while_in_progress CHECK (status <> 'in_progress' OR working_task_id IS NOT NULL)
);

CREATE INDEX tickets_board ON tickets (company_id, status, priority, created_at);
CREATE INDEX tickets_working_task ON tickets (working_task_id) WHERE working_task_id IS NOT NULL;

SELECT app.enable_tenant_rls('tickets');

-- A ticket is closed, never removed: what was asked for, and by whom, is
-- part of the record.
REVOKE DELETE ON tickets FROM palugada_app;
