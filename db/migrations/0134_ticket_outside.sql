-- A ticket says whether the work that filed it had read something from
-- outside the company (F8.9).
--
-- `ticket.list` counted as outside content whatever it returned, so a triage
-- pass over a board holding only the owner's own tickets was tainted, and
-- every tier 2 action in the work it handed out asked the owner with reason
-- "outside", with no yes for a while possible. The same ticket given out from
-- the board with /assign did not ask, because the owner's own ticket is the
-- owner's words. The two ways of handing out one ticket disagreed.
--
-- So the ticket carries what its filer's work had read, worked out in the
-- transaction that files it. On the row, because the events that say a task
-- read outside content are deleted by retention: looked up later, an old
-- ticket filed after a customer's email would look clean.
--
-- A ticket from before this is from outside unless the owner filed it, and so
-- is one imported from an archive written before tickets said: an agent's
-- ticket of unknown provenance is treated as the worst it could be.
ALTER TABLE tickets ADD COLUMN outside boolean NOT NULL DEFAULT true;

-- Reading every ticket as the table's owner is refused by forced row
-- security without a tenant: lifted for this transaction, and put back before
-- it ends (as 0049, 0118 and 0129).
ALTER TABLE tickets NO FORCE ROW LEVEL SECURITY;
UPDATE tickets SET outside = false WHERE opened_by = 'owner';
ALTER TABLE tickets FORCE ROW LEVEL SECURITY;

-- What a ticket says, and where its words came from, are written once, when
-- it is filed. The application role moves a ticket along -- it is taken, it
-- settles with its task, the owner closes it, opens it again, or changes how
-- urgent it is -- and nothing else: no write can make a ticket from outside
-- clean, or put new words in a ticket that was clean.
REVOKE UPDATE ON tickets FROM palugada_app;
GRANT UPDATE (status, priority, working_task_id, closed_reason, closed_at, updated_at) ON tickets TO palugada_app;
