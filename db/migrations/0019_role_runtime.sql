-- Phase 4 (PRD v2): a role names the runtime that executes it (F2.3, F13.5,
-- F13.6).

-- ---------------------------------------------------------------------------
-- NG6 is the change v2 makes that reaches furthest: PALUGADA orchestrates and
-- does not execute. A role therefore has to say *what* executes it, on which
-- backend, and with which models -- three things the schema had no room for
-- because in v1 the answer was always "this process".
-- ---------------------------------------------------------------------------
ALTER TABLE roles
  -- Which adapter runs this role. `in-process` is the platform's own
  -- development runtime; the v1 adapters F13.2 names are `claude-code`,
  -- `http` and `script`.
  ADD COLUMN runtime        text NOT NULL DEFAULT 'in-process',
  -- F13.5. The PRD's default is `docker`, and that default applies from the
  -- moment a role names a runtime that launches something. A role executed
  -- in-process launches nothing, so `local` is not a weaker choice for it --
  -- it is the only true one, and the constraint below says so rather than
  -- letting the column carry a value that describes nothing.
  ADD COLUMN backend        text NOT NULL DEFAULT 'local',
  -- F13.6. Named per role because section 12 wants one provider's outage not
  -- to take the platform with it, and section 14.5 leaves the mapping open --
  -- so these are the role's words, resolved by the adapter.
  ADD COLUMN model_primary  text,
  ADD COLUMN model_fallback text[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT roles_backend_known
    CHECK (backend IN ('local', 'docker', 'remote_sandbox')),
  ADD CONSTRAINT roles_in_process_runs_locally
    CHECK (runtime <> 'in-process' OR backend = 'local');

COMMENT ON COLUMN roles.runtime IS
  'F13.1: the adapter that executes this role. PALUGADA never calls a model to '
  'do a task; the runtime does (NG6).';
