-- A frozen role says who froze it (the owner's report of 7 October: "I have to
-- start the agents again one by one ... a 24/7 company should handle that
-- itself").
--
-- Four things leave a role stopped, and only one of them is over by itself:
--   owner        the owner paused it, and resuming is theirs;
--   denials      F3.7 froze it for being refused over and over, which waiting
--                does not mend;
--   spend        F1.8 froze it for spending far above its week, which is over
--                when the burst is out of the last hour;
--   spend_held   F1.8 froze it for the third time in a day, which is a role
--                whose usual is wrong, not a burst, and is the owner's.
-- Until now the freeze was one column and every freeze waited for a person.
-- A row frozen before this migration is given the cause its reason names, and
-- a burst that was waiting for the owner stays theirs: nobody is surprised by
-- a role that goes back to work after they were told it was stopped.
ALTER TABLE roles ADD COLUMN frozen_by text;

-- Reading every frozen role as the table's owner is refused by forced row
-- security without a tenant: lifted for this transaction, and put back before
-- it ends (as 0049 and 0118).
ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
UPDATE roles SET frozen_by = CASE
  WHEN frozen_reason LIKE 'paused by the owner%' THEN 'owner'
  WHEN frozen_reason LIKE '%times its usual rate' THEN 'spend_held'
  ELSE 'denials'
END WHERE frozen_at IS NOT NULL;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;

ALTER TABLE roles
  ADD CONSTRAINT roles_frozen_by_is_known
    CHECK (frozen_by IS NULL OR frozen_by IN ('owner', 'denials', 'spend', 'spend_held')),
  ADD CONSTRAINT roles_frozen_by_needs_a_freeze
    CHECK (frozen_by IS NULL OR frozen_at IS NOT NULL);
