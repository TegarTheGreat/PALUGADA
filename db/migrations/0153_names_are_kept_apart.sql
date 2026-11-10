-- Names are kept apart, and a handle is locked after wrong codes (F19.21,
-- F19.22; STATUS section 2.209).
--
-- The owner names every seat, and two people of one company must not look
-- alike in a room: a name is compared on its skeleton, the form Unicode's
-- confusables (UTS #39) reduce it to, so "Siti" written with a Cyrillic i is
-- the same name as "Siti". The skeleton is computed in code
-- (src/owner/confusables.ts and src/owner/staff.ts), since PostgreSQL has no
-- table of look-alike letters; the index holds two live seats of a company
-- to different ones, whoever writes them at once. A seat seated before this
-- has none until its company's seats are next read, and when two of those
-- share one, the later keeps none and the owner is asked to rename one.
--
-- A seat signs in with its handle and its code, and five wrong codes for one
-- handle lock it, from any address, for a minute that doubles to at most an
-- hour. Counted on the seat rather than in a process's memory, so a lock
-- holds across replicas and restarts.
--
-- staff_seats stays the control plane's alone (0110).
ALTER TABLE staff_seats
  ADD COLUMN name_skeleton text,
  ADD COLUMN sign_in_failures smallint NOT NULL DEFAULT 0
    CONSTRAINT staff_seats_failures_counted CHECK (sign_in_failures >= 0),
  ADD COLUMN locked_until timestamptz;
CREATE UNIQUE INDEX staff_seats_name_apart ON staff_seats (company_id, name_skeleton)
  WHERE name_skeleton IS NOT NULL AND revoked_at IS NULL;
