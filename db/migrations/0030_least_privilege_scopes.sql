-- F12.6: least privilege on third-party tokens.
--
-- A P0 that had never been graded. It appeared in no column of the status
-- table -- not built, not partial, not done, absent -- and nothing in the
-- repository cited it. What follows is the half of it PALUGADA can actually
-- enforce, and the other half is named here rather than implied.
--
-- The half it cannot enforce: what scopes a token *really* carries is known
-- only to the provider that issued it. PALUGADA holds a reference, never a
-- value (F12.1), so it cannot introspect a GitHub token any more than it can
-- read it.
--
-- The half it can, and it is the half that matters operationally, because
-- over-scoped tokens are made by people rather than by providers. A credential
-- declares the scopes it was issued with, a capability declares the scopes it
-- needs, and the two are squeezed together from both sides:
--
--   * A credential may not declare a scope that no capability its division is
--     granted actually needs. Pasting an organisation-admin token into a
--     division that only reads DNS is refused, naming the excess.
--   * A capability may not be run with a credential whose declared scopes do
--     not cover what it needs. That refusal happens here rather than at the
--     provider, with a reason.
--
-- Squeezed from both sides is what makes the declaration non-optional.
-- Declaring nothing is not a way out: the resolve-side check then refuses
-- every capability that needs a scope. Declaring everything is not a way out
-- either: the division-side check refuses it. The only declaration that passes
-- both is the true one, which is the point.
--
-- Empty stays legal on purpose. A capability that needs no scope -- every
-- read of the company's own store -- and a credential for it are the common
-- case, and requiring ceremony there would push people towards declaring
-- something untrue.

ALTER TABLE capabilities
  ADD COLUMN required_scopes text[] NOT NULL DEFAULT '{}';

ALTER TABLE credentials
  ADD COLUMN scopes text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN capabilities.required_scopes IS
  'F12.6: the provider scopes this capability needs, declared by its adapter.';
COMMENT ON COLUMN credentials.scopes IS
  'F12.6: the scopes this token was issued with, as declared by whoever added it.';

-- Every scope any capability this division is granted asks for. The union is
-- the widest a credential in that division may legitimately be.
CREATE OR REPLACE FUNCTION app.division_permitted_scopes(target_division uuid)
RETURNS text[]
LANGUAGE sql STABLE AS $$
  SELECT coalesce(array_agg(DISTINCT scope), '{}')
    FROM capability_grants g
    JOIN capabilities c ON c.name = g.capability_name
    CROSS JOIN LATERAL unnest(c.required_scopes) AS scope
   WHERE g.division_id = target_division;
$$;

CREATE OR REPLACE FUNCTION app.credentials_stay_least_privileged() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  permitted text[];
  excess    text[];
BEGIN
  IF array_length(NEW.scopes, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  permitted := app.division_permitted_scopes(NEW.division_id);
  SELECT array_agg(scope) INTO excess
    FROM unnest(NEW.scopes) AS scope
   WHERE NOT (scope = ANY (permitted));

  IF excess IS NOT NULL THEN
    RAISE EXCEPTION
      'credential % declares % which no capability granted to its division needs; '
      'grant the capability first or issue a narrower token (PRD F12.6)',
      NEW.alias, array_to_string(excess, ', ');
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER credentials_stay_least_privileged
  BEFORE INSERT OR UPDATE ON credentials
  FOR EACH ROW EXECUTE FUNCTION app.credentials_stay_least_privileged();

-- The other direction. Revoking a grant, or narrowing what a capability needs,
-- can leave a credential over-scoped after the fact -- and a rule that only
-- holds at insert time is a rule that decays. Checked on the grant side too, so
-- removing the last grant that justified a scope is refused while the
-- credential still declares it.
CREATE OR REPLACE FUNCTION app.grants_keep_credentials_least_privileged() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  division  uuid;
  permitted text[];
  orphaned  record;
BEGIN
  division := CASE TG_OP WHEN 'DELETE' THEN OLD.division_id ELSE NEW.division_id END;
  permitted := app.division_permitted_scopes(division);

  FOR orphaned IN
    SELECT cr.alias, array_agg(scope) AS excess
      FROM credentials cr
      CROSS JOIN LATERAL unnest(cr.scopes) AS scope
     WHERE cr.division_id = division
       AND NOT (scope = ANY (permitted))
     GROUP BY cr.alias
  LOOP
    RAISE EXCEPTION
      'credential % would be left declaring % which nothing in its division needs; '
      'narrow or remove the credential first (PRD F12.6)',
      orphaned.alias, array_to_string(orphaned.excess, ', ');
  END LOOP;

  RETURN NULL;
END;
$$;

CREATE TRIGGER grants_keep_credentials_least_privileged
  AFTER DELETE OR UPDATE ON capability_grants
  FOR EACH ROW EXECUTE FUNCTION app.grants_keep_credentials_least_privileged();
