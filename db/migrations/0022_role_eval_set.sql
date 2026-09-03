-- ---------------------------------------------------------------------------
-- Role eval sets (PRD v2 F17.2, F17.3, F17.4)
--
-- A trajectory is not stored: it is derived from the event log, the step
-- journal and the traces, which are already append-only and already retained
-- (F17.1, F11.7). Storing a second copy would mean two answers to "what did
-- this run do" and a slow argument about which is right.
--
-- What *is* stored is the set of trajectories a role is judged against. An
-- eval case is a snapshot, taken deliberately, of a run somebody decided was
-- worth keeping — as an example to follow, or as one to avoid. It is a copy on
-- purpose: the point of a reference is that it does not change when the thing
-- it references does.
--
-- F17.2 asks for at least five before a role's charter, skills or model
-- routing may be changed without the owner seeing a score. That is a floor
-- rather than a constraint, and it is enforced in code rather than here: a
-- role starts with none, and a schema that refused to store the first four
-- would make the fifth unreachable.
-- ---------------------------------------------------------------------------

CREATE TABLE role_eval_cases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role_id       uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  name          text NOT NULL,
  -- 'positive': the role should do this again. 'negative' (F17.4): it should
  -- not. A halted run and a rejected proposal become negative candidates
  -- automatically, because the failures worth remembering are exactly the ones
  -- nobody feels like writing down afterwards.
  polarity      text NOT NULL DEFAULT 'positive',
  -- Where it came from, kept so a case can be traced back to a real run.
  -- SET NULL rather than CASCADE: retention will eventually purge the run, and
  -- the reference outliving its source is the correct outcome — the snapshot is
  -- the evidence now.
  source_agent_run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  task_input    jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The snapshot, in the shape src/eval/trajectory.ts exports.
  trajectory    jsonb NOT NULL,
  -- What a later run has to do to count as matching this one.
  expectation   jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- F17.4: a case proposed by the system rather than chosen by the owner
  -- waits for a decision before it starts judging anything.
  accepted_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role_id, name),
  CONSTRAINT role_eval_polarity_known CHECK (polarity IN ('positive', 'negative'))
);
SELECT app.enable_tenant_rls('role_eval_cases');
CREATE INDEX role_eval_cases_role_idx ON role_eval_cases (role_id, polarity);

-- F17.3: the score the owner is shown before deciding. Kept rather than
-- computed on demand so that "what did it score when I approved it" stays
-- answerable after the role has changed again.
CREATE TABLE role_eval_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role_id       uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  -- What was about to change: 'charter', 'skills', 'model_routing'.
  triggered_by  text NOT NULL,
  passed        integer NOT NULL DEFAULT 0,
  failed        integer NOT NULL DEFAULT 0,
  detail        jsonb NOT NULL DEFAULT '[]'::jsonb,
  ran_at        timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('role_eval_runs');
CREATE INDEX role_eval_runs_role_idx ON role_eval_runs (role_id, ran_at DESC);
