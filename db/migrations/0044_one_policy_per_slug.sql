-- ---------------------------------------------------------------------------
-- One policy per slug and scope, company-wide and platform-wide included
--
-- `putPolicy` looks the policy up by slug and scope and upserts it with
-- ON CONFLICT (company_id, division_id, slug). The unique constraint behind
-- that treated NULLs as distinct, as PostgreSQL does unless told otherwise --
-- and a company-wide policy has a NULL division, a platform policy a NULL
-- company. So for exactly those two scopes, the ones an owner writes most,
-- every "update" inserted a second row: the governance log said the policy
-- was updated, and the old rule went on being enforced beside the new one.
-- An owner who relaxed a deny had not relaxed anything.
--
-- Existing duplicates keep their newest row, which is the one the owner last
-- wrote and the one the log describes. Policies are control-plane rows under
-- forced row security, so the cleanup runs with that lifted for the length of
-- this transaction and restores it before it ends.
-- ---------------------------------------------------------------------------

ALTER TABLE policies NO FORCE ROW LEVEL SECURITY;

DELETE FROM policies older
 USING policies newer
 WHERE older.slug = newer.slug
   AND older.company_id IS NOT DISTINCT FROM newer.company_id
   AND older.division_id IS NOT DISTINCT FROM newer.division_id
   AND (older.created_at, older.id) < (newer.created_at, newer.id);

ALTER TABLE policies FORCE ROW LEVEL SECURITY;

ALTER TABLE policies
  DROP CONSTRAINT policies_company_id_division_id_slug_key,
  ADD CONSTRAINT policies_scope_slug_key
    UNIQUE NULLS NOT DISTINCT (company_id, division_id, slug);
