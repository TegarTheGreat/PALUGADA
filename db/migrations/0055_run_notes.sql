-- ---------------------------------------------------------------------------
-- What a run says while it works
--
-- An agent CLI narrates as it goes -- "reading the zone", "the invoice does
-- not match, checking the ledger" -- and the wire threw every line away, so
-- the owner watching a task that had run for twenty minutes saw a step count
-- and nothing of what the agent was thinking. Buzz keeps a thread per task;
-- this keeps the narration per run, redacted and bounded, beside the steps.
--
-- Not the journal. F11.1 asks for a trace of model calls and tool calls, and
-- narration is neither; nothing is replayed from it and nothing depends on it.
-- It is for a person to read. Append-only for the application role, which
-- writes it as the run goes, and cannot rewrite what a run said.
-- ---------------------------------------------------------------------------

CREATE TABLE run_notes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  task_id       uuid NOT NULL,
  agent_run_id  uuid NOT NULL,
  seq           integer NOT NULL,
  body          text NOT NULL,
  said_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (agent_run_id, seq),
  CONSTRAINT run_notes_task_fkey
    FOREIGN KEY (company_id, task_id) REFERENCES tasks (company_id, id) ON DELETE CASCADE,
  CONSTRAINT run_notes_run_fkey
    FOREIGN KEY (company_id, agent_run_id) REFERENCES agent_runs (company_id, id) ON DELETE CASCADE,
  CONSTRAINT run_notes_body_bounded CHECK (length(body) BETWEEN 1 AND 2000),
  CONSTRAINT run_notes_seq_positive CHECK (seq >= 1)
);

CREATE INDEX run_notes_by_task ON run_notes (task_id, said_at);

SELECT app.enable_tenant_rls('run_notes');
REVOKE UPDATE, DELETE ON run_notes FROM palugada_app;
