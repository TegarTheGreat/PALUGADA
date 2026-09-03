-- Phase 4: the sandbox escalation boundary, made a constraint.

-- ---------------------------------------------------------------------------
-- One more registry property (F8.2): whether a capability executes code the
-- platform did not write.
--
-- The sandbox (F8.10) denies the filesystem, child processes, worker threads
-- and native addons, but Node's permission model does not cover sockets, so
-- code running inside it can still open a connection. `src/sandbox/sandbox.ts`
-- says so and names the consequence: a capability that executes untrusted code
-- must not also hold a credential or reach a tier 2 action, because this
-- boundary would not stop the code from posting either one somewhere.
--
-- Until now that consequence was a comment, and a comment does not stop a
-- grant. It becomes a constraint here, checked in both directions so the order
-- of configuration cannot get around it.
-- ---------------------------------------------------------------------------
ALTER TABLE capabilities
  ADD COLUMN executes_untrusted_code boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN capabilities.executes_untrusted_code IS
  'True when the capability runs code supplied at call time. Such a capability '
  'cannot share a division with a credential or with a tier >= 2 grant (F8.10).';

-- Does this division already hold a capability that executes untrusted code?
--
-- Written as a function because both triggers ask the same question from
-- opposite sides, and an invariant enforced by two subtly different queries is
-- an invariant that will eventually hold in only one direction.
CREATE OR REPLACE FUNCTION app.division_executes_untrusted_code(
  target_division uuid,
  excluding_grant uuid DEFAULT NULL
) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM capability_grants g
      JOIN capabilities c ON c.name = g.capability_name
     WHERE g.division_id = target_division
       AND c.executes_untrusted_code
       AND (excluding_grant IS NULL OR g.id <> excluding_grant)
  )
$$;

-- The effective tier of a grant: a grant may tighten but never loosen (F8.3),
-- so the stricter of the registry default and the override is what actually
-- applies.
CREATE OR REPLACE FUNCTION app.grant_effective_tier(
  registry_tier smallint,
  override smallint
) RETURNS smallint
LANGUAGE sql IMMUTABLE AS $$
  SELECT greatest(registry_tier, coalesce(override, registry_tier))
$$;

CREATE OR REPLACE FUNCTION app.grants_respect_sandbox_boundary() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  incoming_tier     smallint;
  incoming_executes boolean;
  conflicting       text;
BEGIN
  SELECT app.grant_effective_tier(c.default_tier, NEW.tier_override),
         c.executes_untrusted_code
    INTO incoming_tier, incoming_executes
    FROM capabilities c
   WHERE c.name = NEW.capability_name;

  IF incoming_executes THEN
    -- A credential scoped to this division is reachable by the code, and the
    -- sandbox does not stop it leaving.
    IF EXISTS (SELECT 1 FROM credentials WHERE division_id = NEW.division_id) THEN
      RAISE EXCEPTION
        'division % holds a credential, so it cannot also be granted %, which executes untrusted code (PRD F8.10)',
        NEW.division_id, NEW.capability_name
        USING ERRCODE = '42501';
    END IF;

    -- Section 12 names the combination directly: a tier 3 effect reached by
    -- assembling lesser actions. Code execution next to a tier 2 grant is that
    -- combination with the assembly already done.
    SELECT g.capability_name INTO conflicting
      FROM capability_grants g
      JOIN capabilities c ON c.name = g.capability_name
     WHERE g.division_id = NEW.division_id
       AND g.id <> NEW.id
       AND app.grant_effective_tier(c.default_tier, g.tier_override) >= 2
     LIMIT 1;

    IF conflicting IS NOT NULL THEN
      RAISE EXCEPTION
        'division % is granted %, at tier 2 or above, so it cannot also be granted %, which executes untrusted code (PRD F8.10)',
        NEW.division_id, conflicting, NEW.capability_name
        USING ERRCODE = '42501';
    END IF;

  ELSIF incoming_tier >= 2
    AND app.division_executes_untrusted_code(NEW.division_id, NEW.id) THEN
    RAISE EXCEPTION
      'division % is granted a capability that executes untrusted code, so it cannot also be granted %, at tier % (PRD F8.10)',
      NEW.division_id, NEW.capability_name, incoming_tier
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER grants_respect_sandbox_boundary
  BEFORE INSERT OR UPDATE ON capability_grants
  FOR EACH ROW EXECUTE FUNCTION app.grants_respect_sandbox_boundary();

CREATE OR REPLACE FUNCTION app.credentials_respect_sandbox_boundary() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app.division_executes_untrusted_code(NEW.division_id) THEN
    RAISE EXCEPTION
      'division % is granted a capability that executes untrusted code, so a credential cannot be scoped to it (PRD F8.10)',
      NEW.division_id
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER credentials_respect_sandbox_boundary
  BEFORE INSERT OR UPDATE ON credentials
  FOR EACH ROW EXECUTE FUNCTION app.credentials_respect_sandbox_boundary();
