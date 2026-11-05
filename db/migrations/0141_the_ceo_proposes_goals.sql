-- The CEO proposes the company's goals (F18.7).
--
-- A plan of new goals is proposed with goal.propose and approved by the owner
-- line by line, and the CEO is the role that plans: it runs the weekly and
-- the quarterly rhythm. The founding CEO held twelve tools, the most a role
-- may (F2.6), and goal.propose was not one of them, so the founding template
-- now trades doc.draft for it (src/templates/founding.ts): drafting is work
-- the CEO hands to a role whose job it is.
--
-- A CEO founded before that still holds the old twelve. Where its tools are
-- still exactly what it was founded with -- whatever their order -- they are
-- traded the same way, with the version of the role as it was recorded first,
-- as the owner's own change records it (`applyRoleChange`), so the history
-- shows the change and a rollback restores it. A CEO whose owner changed its
-- tools is the owner's, and is left as it is. The sentence of the founding
-- charter that told it to write drafts is replaced where it still reads as it
-- was written; a charter the owner rewrote is theirs too.
--
-- Its division is granted goal.propose where it has no grant for it yet, with
-- a version of the grant, and keeps its grant for doc.draft, so the owner can
-- trade it back on Team. The grant needs the capability in the catalogue,
-- which the platform writes when it starts: a database migrated before the
-- platform first ran has no catalogue, and its CEO's division is granted the
-- tool when the owner grants it on Team, as any ungranted tool is.
--
-- Reading and writing every company's roles, grants and versions as the
-- tables' owner is refused by forced row security without a tenant: lifted
-- for this transaction, and put back before it ends (as 0133 and 0135).
ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE capability_grants NO FORCE ROW LEVEL SECURITY;
ALTER TABLE config_versions NO FORCE ROW LEVEL SECURITY;

CREATE TEMPORARY TABLE ceo_traded ON COMMIT DROP AS
  SELECT r.id, r.company_id, r.division_id
    FROM roles r
   WHERE r.title = 'CEO'
     AND cardinality(r.tools) = 12
     AND r.tools @> ARRAY['memory.search', 'skill.read', 'plan.record', 'metric.record', 'owner.ask', 'task.delegate',
                          'task.await', 'schedule.propose', 'ticket.create', 'ticket.list', 'task.follow_up', 'doc.draft']
     AND r.tools <@ ARRAY['memory.search', 'skill.read', 'plan.record', 'metric.record', 'owner.ask', 'task.delegate',
                          'task.await', 'schedule.propose', 'ticket.create', 'ticket.list', 'task.follow_up', 'doc.draft'];

-- The role as it was, in the shape `applyRoleChange` records before a change.
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
       'State of ' || r.slug || ' before it was given goal.propose in place of doc.draft (0141)',
       'platform'
  FROM roles r JOIN ceo_traded t ON t.id = r.id;

UPDATE roles r
   SET tools = array_replace(r.tools, 'doc.draft', 'goal.propose'),
       system_prompt = replace(r.system_prompt,
         'as far as your own tools reach: read, research, and write a draft with doc.draft.',
         'as far as your own tools reach, and say what is left for a role to do. When the owner asks for a plan, or a '
         || 'quarter is ending, propose the goals as one plan with goal.propose and its plan: each new goal with the goal '
         || 'it hangs from, its period, the one seat that owns it, how firmly it is committed and what is true once it is '
         || 'done; a learning goal with a measure whose target is the prediction, set now. The owner approves it line by '
         || 'line, and the goals exist once they do.')
  FROM ceo_traded t
 WHERE t.id = r.id;

WITH granted AS (
  INSERT INTO capability_grants (company_id, division_id, capability_name)
  SELECT DISTINCT t.company_id, t.division_id, 'goal.propose'
    FROM ceo_traded t
   WHERE EXISTS (SELECT 1 FROM capabilities c WHERE c.name = 'goal.propose')
  ON CONFLICT (division_id, capability_name) DO NOTHING
  RETURNING company_id, division_id
)
INSERT INTO config_versions (company_id, kind, subject_id, version, snapshot, summary, changed_by)
SELECT g.company_id, 'grant', g.division_id,
       coalesce((SELECT max(v.version) FROM config_versions v
                  WHERE v.company_id = g.company_id AND v.kind = 'grant' AND v.subject_id = g.division_id), 0) + 1,
       jsonb_build_object('capability', 'goal.propose', 'before', NULL,
                          'after', jsonb_build_object('tierOverride', NULL, 'maxInFlight', NULL)),
       'Change the grant for goal.propose (0141)',
       'platform'
  FROM granted g;

ALTER TABLE config_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE capability_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
