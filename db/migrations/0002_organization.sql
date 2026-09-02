-- Organizational structure: divisions, roles, capability grants (PRD F2, F8).
--
-- A division is a scope, not a headcount (PRD principle 3): it is defined by
-- the capabilities granted to it, its budget, its SOPs and its escalation
-- path.


-- F2.2: at most two levels (division -> sub-division). The CHECK constraint
-- states the invariant and the trigger derives depth from the parent, so the
-- constraint cannot be sidestepped by writing depth directly.
CREATE TABLE divisions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  parent_division_id  uuid REFERENCES divisions(id) ON DELETE CASCADE,
  depth               smallint NOT NULL DEFAULT 0,
  slug                text NOT NULL,
  name                text NOT NULL,
  -- F5.7: bounds concurrent agent runs belonging to this division.
  max_concurrency     smallint NOT NULL DEFAULT 4,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, slug),
  CONSTRAINT divisions_depth_within_two_levels CHECK (depth BETWEEN 0 AND 1),
  CONSTRAINT divisions_parent_matches_depth
    CHECK ((depth = 0 AND parent_division_id IS NULL)
        OR (depth = 1 AND parent_division_id IS NOT NULL)),
  CONSTRAINT divisions_concurrency_positive CHECK (max_concurrency >= 1)
);

CREATE OR REPLACE FUNCTION app.divisions_derive_depth() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE parent_depth smallint; parent_company uuid;
BEGIN
  IF NEW.parent_division_id IS NULL THEN
    NEW.depth := 0;
    RETURN NEW;
  END IF;

  SELECT depth, company_id INTO parent_depth, parent_company
    FROM divisions WHERE id = NEW.parent_division_id;

  IF parent_depth IS NULL THEN
    RAISE EXCEPTION 'parent division % does not exist', NEW.parent_division_id;
  END IF;
  IF parent_company <> NEW.company_id THEN
    RAISE EXCEPTION 'a sub-division must belong to the same company as its parent';
  END IF;

  NEW.depth := parent_depth + 1;
  RETURN NEW;
END $$;

CREATE TRIGGER divisions_derive_depth
  BEFORE INSERT OR UPDATE ON divisions
  FOR EACH ROW EXECUTE FUNCTION app.divisions_derive_depth();

SELECT app.enable_tenant_rls('divisions');

-- F2.3, F2.6: a role is a prompt, typed input/output contracts, a model, a
-- subset of its division's grants, and a per-run token ceiling. The 12-tool
-- limit is a database constraint because F2.6 requires it to be rejected at
-- configuration time rather than negotiated in a prompt.
CREATE TABLE roles (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  division_id         uuid NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
  slug                text NOT NULL,
  system_prompt       text NOT NULL,
  model               text NOT NULL,
  tools               text[] NOT NULL DEFAULT '{}',
  input_schema        jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_schema       jsonb NOT NULL DEFAULT '{}'::jsonb,
  max_tokens_per_run  integer NOT NULL DEFAULT 100000,
  attempt_max         smallint NOT NULL DEFAULT 3,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, slug),
  CONSTRAINT roles_at_most_twelve_tools CHECK (cardinality(tools) <= 12),
  CONSTRAINT roles_attempt_max_positive CHECK (attempt_max >= 1),
  CONSTRAINT roles_token_ceiling_positive CHECK (max_tokens_per_run > 0)
);
SELECT app.enable_tenant_rls('roles');

-- ---------------------------------------------------------------------------
-- Capability registry (platform scope) and per-division grants
-- ---------------------------------------------------------------------------

-- F8.2: the registry is platform-wide and deliberately not tenant-scoped, so
-- it carries no company_id and no RLS policy. It holds no tenant data: only
-- the capability name, its adapter, its default reversibility tier and its
-- cost estimate. Tenants are granted access through capability_grants.
CREATE TABLE capabilities (
  name              text PRIMARY KEY,
  adapter           text NOT NULL,
  -- PRD section 8.8: 0 read-only, 1 cheap reversible write,
  -- 2 expensive/irreversible-in-practice, 3 destructive.
  default_tier      smallint NOT NULL,
  input_schema      jsonb NOT NULL DEFAULT '{}'::jsonb,
  estimated_cost_cents integer NOT NULL DEFAULT 0,
  -- F8.4: a write capability must declare a read-back. The registry records
  -- whether one exists; the broker refuses to register tier >= 1 without it.
  has_verify        boolean NOT NULL DEFAULT false,
  -- F8.8: platform-wide kill switch.
  disabled_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT capabilities_tier_range CHECK (default_tier BETWEEN 0 AND 3),
  CONSTRAINT capabilities_write_requires_verify
    CHECK (default_tier = 0 OR has_verify)
);
GRANT SELECT ON capabilities TO palugada_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON capabilities TO palugada_admin;

-- F2.4, F8.3: a grant may only tighten. tier_override must be >= the
-- registry default, which is checked by trigger because a CHECK constraint
-- cannot reach another table.
CREATE TABLE capability_grants (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  division_id       uuid NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
  capability_name   text NOT NULL REFERENCES capabilities(name) ON DELETE CASCADE,
  tier_override     smallint,
  -- F8.6: rate limit for this capability within this division.
  rate_limit_per_hour integer,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (division_id, capability_name),
  CONSTRAINT grants_tier_range CHECK (tier_override IS NULL OR tier_override BETWEEN 0 AND 3),
  CONSTRAINT grants_rate_limit_positive
    CHECK (rate_limit_per_hour IS NULL OR rate_limit_per_hour > 0)
);

CREATE OR REPLACE FUNCTION app.grants_forbid_tier_loosening() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE registry_tier smallint;
BEGIN
  IF NEW.tier_override IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT default_tier INTO registry_tier
    FROM capabilities WHERE name = NEW.capability_name;

  IF NEW.tier_override < registry_tier THEN
    RAISE EXCEPTION
      'capability % cannot be loosened from tier % to tier % (PRD F8.3)',
      NEW.capability_name, registry_tier, NEW.tier_override
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER grants_forbid_tier_loosening
  BEFORE INSERT OR UPDATE ON capability_grants
  FOR EACH ROW EXECUTE FUNCTION app.grants_forbid_tier_loosening();

SELECT app.enable_tenant_rls('capability_grants');

-- F12.1, F12.2: only a reference to the secret manager is stored, scoped to a
-- division. The secret value never reaches this database.
CREATE TABLE credentials (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  division_id   uuid NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
  alias         text NOT NULL,
  secret_ref    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (division_id, alias),
  CONSTRAINT credentials_ref_is_not_inline_secret
    CHECK (secret_ref ~ '^[a-z0-9]+://')
);
SELECT app.enable_tenant_rls('credentials');
