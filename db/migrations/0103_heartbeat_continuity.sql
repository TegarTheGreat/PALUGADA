-- Since when a worker has said it is alive without a break (B5).
--
-- A worker takes back the running tasks of a worker that has gone quiet
-- (0079). One that had been away itself -- the database gone for a minute,
-- its own loop stalled -- came back to find every other worker's last word as
-- old as its own, and took back work that was going on, each time counting
-- towards the three losses that halt a task as a crash loop. A worker now
-- judges others only once it has been saying it is alive, without a gap
-- longer than two of its intervals, for as long as a holder may be quiet:
-- the others have had the same time to speak again.

ALTER TABLE worker_heartbeats
  ADD COLUMN beating_since timestamptz NOT NULL DEFAULT now();
