-- Phase 2: distillation and candidate SOPs (F4.4, F4.5), adversarial review
-- and decision records (F7), company templates (F2.5), cost alerting (F11.4).

-- ---------------------------------------------------------------------------
-- Candidate SOPs (F4.5)
--
-- A distilled SOP is a proposal, not a fact. Until the owner approves it, it
-- must not reach an agent's context: a pattern the system noticed three times
-- is a hypothesis, and promoting hypotheses to procedure automatically is how
-- a company teaches itself its own mistakes.
-- ---------------------------------------------------------------------------
ALTER TABLE memories
  ADD COLUMN approval_state text NOT NULL DEFAULT 'active',
  ADD COLUMN approved_at timestamptz,
  -- Distinguishes a distilled decision (F7.5) from an ordinary fact, so an
  -- agent can tell "we decided this" from "this is the case".
  ADD COLUMN fact_kind text;

ALTER TABLE memories
  ADD CONSTRAINT memories_approval_state_known
    CHECK (approval_state IN ('active', 'candidate', 'rejected'));

ALTER TABLE memories
  ADD CONSTRAINT memories_fact_kind_known
    CHECK (fact_kind IS NULL OR fact_kind IN ('observation', 'decision', 'sop_candidate'));

CREATE INDEX memories_candidates_idx ON memories (company_id, approval_state)
  WHERE approval_state = 'candidate';

-- ---------------------------------------------------------------------------
-- Policy effect parameters
--
-- The PRD's own example is require_review(reviewer_role: "qa-reviewer"), so an
-- effect can carry an argument. The constraint makes a review policy that
-- names no reviewer impossible to save: "get this reviewed" without saying by
-- whom is a rule that cannot be executed, and discovering that at the moment
-- it first matters is too late.
ALTER TABLE policies ADD COLUMN params jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE policies ADD CONSTRAINT policies_review_names_reviewer
  CHECK (effect <> 'require_review' OR params ? 'reviewer_role');

-- ---------------------------------------------------------------------------
-- Distillation bookkeeping (F4.4)
--
-- Records how far each distillation has consumed, so a nightly job that runs
-- twice does not extract the same facts twice. Without it the semantic layer
-- fills with duplicates that all look like independent corroboration, which is
-- worse than missing them: repetition is how confidence gets manufactured.
-- ---------------------------------------------------------------------------
CREATE TABLE distillation_state (
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  scope_id    uuid NOT NULL,
  kind        text NOT NULL,
  through_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, scope_id, kind),
  CONSTRAINT distillation_kind_known
    CHECK (kind IN ('episodic_to_semantic', 'semantic_to_procedural'))
);
SELECT app.enable_tenant_rls('distillation_state');

-- ---------------------------------------------------------------------------
-- Adversarial review (F7)
--
-- A review gates one specific action, identified by a fingerprint of the
-- capability and its input. Approval is therefore not a mood the task is in --
-- it is a grant for exactly the action that was reviewed. A proposer that
-- comes back with different arguments has not been approved for those.
-- ---------------------------------------------------------------------------
CREATE TABLE review_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id         uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  proposer_task_id   uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  proposer_role_id   uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  reviewer_role_id   uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  review_task_id     uuid REFERENCES tasks(id) ON DELETE SET NULL,
  capability_name    text NOT NULL,
  action_fingerprint text NOT NULL,
  proposal           jsonb NOT NULL,
  criteria           text NOT NULL,
  -- F7.2: two revisions, then it becomes the owner's problem.
  round              smallint NOT NULL DEFAULT 1,
  status             text NOT NULL DEFAULT 'pending',
  decision           text,
  reason             text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  decided_at         timestamptz,
  CONSTRAINT review_status_known
    CHECK (status IN ('pending', 'approved', 'revise', 'rejected', 'escalated')),
  CONSTRAINT review_decision_known
    CHECK (decision IS NULL OR decision IN ('approve', 'revise', 'reject')),
  CONSTRAINT review_round_positive CHECK (round >= 1),
  -- F7.3: the reviewer must not be the proposer. Enforced here rather than in
  -- application code, because a role reviewing its own proposal is not a
  -- review and no amount of prompting makes it one.
  CONSTRAINT review_reviewer_differs_from_proposer
    CHECK (reviewer_role_id <> proposer_role_id),
  UNIQUE (proposer_task_id, action_fingerprint, round)
);
SELECT app.enable_tenant_rls('review_requests');

CREATE INDEX review_pending_idx ON review_requests (company_id, status)
  WHERE status = 'pending';

-- Links a decision record back to the review that produced it (F7.4).
ALTER TABLE decision_records
  ADD COLUMN review_request_id uuid REFERENCES review_requests(id) ON DELETE SET NULL,
  ADD COLUMN proposer_role_id uuid REFERENCES roles(id) ON DELETE SET NULL,
  ADD COLUMN reviewer_role_id uuid REFERENCES roles(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Company templates (F1.1, F2.5)
--
-- Platform-scope configuration, so a new company is data rather than a
-- deployment (G7). Not tenant-scoped: a template describes a shape, and holds
-- no tenant content.
-- ---------------------------------------------------------------------------
CREATE TABLE company_templates (
  slug        text PRIMARY KEY,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  body        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- No tenant column exists because a template holds no tenant content, only a
-- shape. The application role gets no grant at all: creating a company is a
-- control-plane act, and an agent has no reason to read the catalogue of
-- shapes other companies were built from.
GRANT SELECT, INSERT, UPDATE, DELETE ON company_templates TO palugada_admin;

-- ---------------------------------------------------------------------------
-- Alert thresholds (F11.4)
--
-- A NULL company_id row is the platform default; a company row overrides it.
-- Thresholds are configuration rather than constants in code because F11.4
-- expects them to be tuned weekly against the calibration metrics in
-- section 11, and a threshold you have to redeploy to change is one nobody
-- tunes.
-- ---------------------------------------------------------------------------
CREATE TABLE alert_thresholds (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                uuid REFERENCES companies(id) ON DELETE CASCADE,
  daily_cost_cents          integer NOT NULL DEFAULT 10000,
  task_failure_rate         real NOT NULL DEFAULT 0.2,
  policy_denials_per_day    integer NOT NULL DEFAULT 20,
  verification_failures_per_day integer NOT NULL DEFAULT 1,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alert_thresholds_one_per_scope UNIQUE (company_id),
  CONSTRAINT alert_failure_rate_range CHECK (task_failure_rate >= 0 AND task_failure_rate <= 1)
);
INSERT INTO alert_thresholds (company_id) VALUES (NULL);

-- A company-scoped row is tenant data: it reveals that company's cost ceiling
-- and its tolerance for failure. The platform default (company_id IS NULL) is
-- readable by everyone, the overrides are not.
SELECT app.enable_shared_scope_rls('alert_thresholds');

-- Keeps an alert from being raised again every sweep while the same condition
-- persists. Without it a single overspend produces one inbox item per minute,
-- which is the fastest way to make the owner stop reading the inbox.
CREATE TABLE alert_state (
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  day         date NOT NULL,
  raised_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, kind, day)
);
SELECT app.enable_tenant_rls('alert_state');
