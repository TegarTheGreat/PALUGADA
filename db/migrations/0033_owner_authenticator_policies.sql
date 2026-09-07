-- ---------------------------------------------------------------------------
-- Saying "nobody" out loud (PRD v2 F12.5)
--
-- 0031 gave `owner_authenticators` and `owner_authentications` FORCE ROW LEVEL
-- SECURITY and no policy at all, on the reasoning that a table with RLS forced
-- and nothing permitted is the tightest thing PostgreSQL offers: only a
-- BYPASSRLS role reaches it, which is the control plane, which is the point.
--
-- That reasoning was right about the effect and wrong about the shape.
-- `tenant-isolation.test.ts` refuses a table that enables RLS and defines no
-- policy, and it is refusing the right thing: the overwhelmingly common cause
-- of that state is somebody enabling RLS and forgetting the policy, which
-- leaves a table nobody can read and a feature that quietly does not work.
-- "Deliberately nothing" and "forgot" look identical in the catalogue.
--
-- So the intent is written down where it can be read, instead of being an
-- absence that has to be explained. `USING (false)` says the same thing the
-- missing policy said and says it in the schema: no role subject to row-level
-- security may see the owner's second factor, and the control plane reaches it
-- by being BYPASSRLS rather than by being permitted.
--
-- It is not decoration. An agent that could read a TOTP secret could mint its
-- own approvals; one that could insert an authenticator could enrol itself as
-- the owner's phone. Both are the whole of what F10.10 asks the second factor
-- to prevent.
-- ---------------------------------------------------------------------------

CREATE POLICY control_plane_only ON owner_authenticators
  USING (false)
  WITH CHECK (false);

CREATE POLICY control_plane_only ON owner_authentications
  USING (false)
  WITH CHECK (false);
