-- A CEO whose charter the owner rewrote keeps doc.draft (F18.7, after 0141).
--
-- 0141 traded doc.draft for goal.propose wherever the CEO's tools were still
-- the founding twelve, and replaced the charter's sentence that told it to
-- draft with doc.draft wherever that sentence still read as written. It
-- traded the tools whether or not the sentence was replaced. So a CEO whose
-- owner had reworded that sentence, and kept the twelve tools, lost
-- doc.draft while its charter still told it to draft with doc.draft, and was
-- never told of goal.propose: every "draft this" ran doc.draft and was
-- refused. 0141 says a charter the owner rewrote is theirs; the tools that
-- charter names are theirs too.
--
-- So where 0141 traded a CEO's tools and left its charter as it found it --
-- the role's tools are still exactly what 0141 made of the twelve, and its
-- charter is still what 0141 recorded before the trade -- goal.propose is
-- traded back for doc.draft, with the role as it was recorded first, as the
-- owner's own change records it (`applyRoleChange`), so the history shows
-- both changes and a rollback restores either. A CEO whose owner changed its
-- tools or its charter since is left as the owner made it. The division
-- keeps both grants, so the owner can trade it again on Team; without
-- goal.propose the quarterly planning tells the CEO to put its plan to the
-- owner in words (src/engine/quarter.ts).
--
-- Reading and writing every company's roles and versions as the tables'
-- owner is refused by forced row security without a tenant: lifted for this
-- transaction, and put back before it ends (as 0141).
ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE config_versions NO FORCE ROW LEVEL SECURITY;

CREATE TEMPORARY TABLE ceo_untraded ON COMMIT DROP AS
  SELECT r.id
    FROM roles r
    JOIN LATERAL (
      SELECT v.snapshot FROM config_versions v
       WHERE v.company_id = r.company_id AND v.kind = 'role' AND v.subject_id = r.id
         AND v.changed_by = 'platform'
         AND v.summary = 'State of ' || r.slug || ' before it was given goal.propose in place of doc.draft (0141)'
       ORDER BY v.version DESC LIMIT 1) traded ON true
   WHERE r.title = 'CEO'
     AND r.system_prompt = traded.snapshot->>'systemPrompt'
     AND r.tools = array_replace(ARRAY(SELECT jsonb_array_elements_text(traded.snapshot->'tools')), 'doc.draft', 'goal.propose');

INSERT INTO config_versions (company_id, kind, subject_id, version, snapshot, summary, changed_by)
SELECT r.company_id, 'role', r.id,
       coalesce((SELECT max(v.version) FROM config_versions v
                  WHERE v.company_id = r.company_id AND v.kind = 'role' AND v.subject_id = r.id), 0) + 1,
       jsonb_build_object(
         'slug', r.slug, 'systemPrompt', r.system_prompt, 'tools', to_jsonb(r.tools),
         'modelPrimary', coalesce(r.model_primary, r.model), 'modelFallback', to_jsonb(r.model_fallback),
         'runtime', r.runtime, 'displayName', r.display_name, 'title', r.title, 'persona', r.persona,
         'doneCriteria', to_jsonb(r.done_criteria), 'maxRunSeconds', r.max_run_seconds,
         'accountabilities', to_jsonb(r.accountabilities)),
       'State of ' || r.slug || ' before doc.draft was given back in place of goal.propose, since its charter is the owner''s (0145)',
       'platform'
  FROM roles r JOIN ceo_untraded u ON u.id = r.id;

UPDATE roles r
   SET tools = array_replace(r.tools, 'goal.propose', 'doc.draft')
  FROM ceo_untraded u
 WHERE u.id = r.id;

ALTER TABLE config_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
