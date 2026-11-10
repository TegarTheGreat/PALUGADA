-- Whether a failed preflight is one that passes on its own (H2).
--
-- Any 429, 5xx or dropped connection made a capability unhealthy for fifteen
-- minutes, and every task that needed it then was halted for good, each to be
-- run again by hand. A vendor's bad moment is not a revoked key: a reading
-- the vendor itself says is passing -- busy, failing on its side, not
-- answering -- is kept for a minute rather than fifteen, and the task waits
-- for it instead of halting.

ALTER TABLE capability_health
  ADD COLUMN transient boolean NOT NULL DEFAULT false;
