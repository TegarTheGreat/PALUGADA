-- Whether the owner has said who hears first about a division's trouble (F2.1).
--
-- A division that names no escalation role sent every failure of its work
-- straight to the owner, and every division a real company has names none:
-- the founding template sets no policy, nor does a division the CEO adds or a
-- bundle brings. The CEO, which `governance/ceo.ts` says hears a division's
-- trouble before the owner, was asked only in the tests' own fixture. A
-- division that never said now has the CEO asked first.
--
-- No role reads back the same for "never said" and for the owner's own
-- "straight to me", which has to stay theirs: this column tells them apart.
-- It is true once the owner names a role or nobody (`setEscalationPolicy`),
-- or a template names one. An event is not enough to tell by: retention
-- deletes old events, and with them the owner's setting would come undone.
ALTER TABLE divisions ADD COLUMN escalation_set boolean NOT NULL DEFAULT false;

-- A division that holds a role or a time, or whose owner left the event of
-- setting either, was set before this column existed, and keeps doing what it
-- did: the owner's form always sends a role or nobody with its time, so a time
-- with no role is a "straight to me" the owner chose. Reading every division
-- and event as the tables' owner is refused by forced row security without a
-- tenant: lifted for this transaction, and put back before it ends (as 0049,
-- 0118 and 0129).
ALTER TABLE divisions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE events NO FORCE ROW LEVEL SECURITY;
UPDATE divisions d SET escalation_set = true
 WHERE d.escalation_role_slug IS NOT NULL
    OR d.escalate_after_minutes IS NOT NULL
    OR EXISTS (SELECT 1 FROM events e
                WHERE e.company_id = d.company_id
                  AND e.type = 'division.escalation_set'
                  AND e.payload->>'divisionId' = d.id::text);
ALTER TABLE events FORCE ROW LEVEL SECURITY;
ALTER TABLE divisions FORCE ROW LEVEL SECURITY;
