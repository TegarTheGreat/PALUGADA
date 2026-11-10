-- A ticket that proposes a hire (the audit of 10 October: "a Hire: ticket is
-- a prompt convention; no code reads or surfaces the 'Hire:' prefix").
--
-- Adding a role is the owner's (F2.9). The CEO was told to file a ticket whose
-- title began "Hire:", and nothing read the prefix: the ticket was offered to
-- the CEO's own triage as work to hand on to nobody, and the owner saw it only
-- by opening the board. A ticket now says what it is. `hire` is a role the
-- company lacks and the work it would take over: the owner is shown it the
-- moment it is filed, and it is never triaged as work.
ALTER TABLE tickets ADD COLUMN kind text NOT NULL DEFAULT 'work';
ALTER TABLE tickets ADD CONSTRAINT tickets_kind_known CHECK (kind IN ('work', 'hire'));
