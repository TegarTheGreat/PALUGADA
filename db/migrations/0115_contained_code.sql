-- Code that reaches no network (STATUS 2.132, the tools research's sixth
-- recommendation).
--
-- 0008 made F8.10 a constraint: a capability that runs code supplied at call
-- time cannot share a division with a credential or a tier 2 grant, because
-- the sandbox does not isolate the network and so cannot stop the code from
-- posting either one somewhere.
--
-- `code.compute` runs its code in a container started with `--network none`,
-- handed no credential: there is nowhere for it to post anything. The reason
-- for the refusal does not apply to it, and keeping the refusal would keep
-- figures away from Finance, the division that holds both a key and a tier 2
-- grant and has the most figures to work out. So the claim is recorded beside
-- the flag it qualifies, and the two functions 0008 wrote to ask "does this
-- run untrusted code" now ask "does this run untrusted code that can reach
-- the network". Everything else in them is 0008's, unchanged.
--
-- The claim is only ever made by the platform's own binding: the registry
-- refuses a capability whose flags differ from the catalogue's, and nothing
-- a vendor file or an MCP server declares can set it.
-- ---------------------------------------------------------------------------
ALTER TABLE capabilities
  ADD COLUMN network_isolated boolean NOT NULL DEFAULT false;

-- Isolation is a property of code that runs; on anything else it would be a
-- claim with nothing behind it.
ALTER TABLE capabilities
  ADD CONSTRAINT capabilities_isolation_is_of_code
  CHECK (NOT network_isolated OR executes_untrusted_code);

COMMENT ON COLUMN capabilities.network_isolated IS
  'True when the code a capability runs can reach no network: a container '
  'with --network none and no credential. Such a capability may share a '
  'division with a credential or a tier 2 grant (F8.10, 0115).';

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
       AND NOT c.network_isolated
       AND (excluding_grant IS NULL OR g.id <> excluding_grant)
  )
$$;

CREATE OR REPLACE FUNCTION app.grants_respect_sandbox_boundary() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  incoming_tier     smallint;
  incoming_executes boolean;
  conflicting       text;
BEGIN
  SELECT app.grant_effective_tier(c.default_tier, NEW.tier_override),
         c.executes_untrusted_code AND NOT c.network_isolated
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
