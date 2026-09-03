-- Phase 4 (PRD v2): capability preflight (F8.12).

-- ---------------------------------------------------------------------------
-- v2 section 2.3 records a secret that was misconfigured and failed silently
-- for half a day: every call failed, every failure looked like a transient
-- error, and the retries hid it. Preflight is the check that would have said
-- so in the first minute.
--
-- Health is recorded per division, not per capability, because the thing being
-- checked is usually a credential and credentials are division-scoped (F12.2).
-- A platform-wide "is email.send healthy" would answer a question nobody
-- asked: it is healthy for the division whose token is valid and unhealthy for
-- the one whose token expired.
--
-- One row per (division, capability), overwritten. The history that matters is
-- in the event log and in the incident; keeping every probe here would grow
-- without bound and make the current state harder to read, which is the one
-- thing this table exists to answer.
-- ---------------------------------------------------------------------------
CREATE TABLE capability_health (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  division_id     uuid NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
  capability_name text NOT NULL REFERENCES capabilities(name) ON DELETE CASCADE,
  status          text NOT NULL,
  detail          text NOT NULL DEFAULT '',
  checked_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (division_id, capability_name),
  CONSTRAINT capability_health_status_known
    CHECK (status IN ('healthy', 'unhealthy'))
);
SELECT app.enable_tenant_rls('capability_health');

-- The gate reads "is anything this role needs unhealthy", which is this index.
CREATE INDEX capability_health_unhealthy
  ON capability_health (division_id) WHERE status = 'unhealthy';
