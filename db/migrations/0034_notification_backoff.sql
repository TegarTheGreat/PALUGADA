-- ---------------------------------------------------------------------------
-- When a notification was last attempted (PRD v2 F10.5, F10.9)
--
-- 0032 counted attempts and had nowhere to record *when* one happened, which
-- made the retry budget useless in the one situation it exists for. The worker
-- runs `dispatch` and then `retryFailed` inside a single tick, so a channel
-- that was briefly unreachable burned two of its three attempts milliseconds
-- apart and the third on the next tick a few seconds later. A relay restarting
-- -- the ordinary case, not the exotic one -- would have exhausted the row
-- before it came back, and the owner would never have been told.
--
-- With the timestamp the retry can wait: an attempt is only repeated once
-- enough time has passed for the thing that failed to have changed. Doubling
-- the wait each time is the ordinary shape, and it matters here because the
-- alternative -- a fixed delay -- either gives up too early on an outage or
-- delays the first retry of a transient blip for no reason.
-- ---------------------------------------------------------------------------

-- Filled by the default rather than by an UPDATE. `owner_notifications` is
-- tenant-scoped under FORCE ROW LEVEL SECURITY, and a migration has no tenant
-- context -- an UPDATE here fails with "app.company_id is required", which is
-- the isolation working rather than a problem to route around. The default
-- backfills every existing row in the same statement, and the only cost is
-- that a row already waiting has its clock restarted once.
ALTER TABLE owner_notifications
  ADD COLUMN last_attempt_at timestamptz NOT NULL DEFAULT now();

-- The retry sweep reads exactly this: undelivered, not yet out of attempts,
-- and last tried long enough ago.
DROP INDEX IF EXISTS owner_notifications_undelivered_idx;
CREATE INDEX owner_notifications_undelivered_idx
  ON owner_notifications (company_id, channel, last_attempt_at)
  WHERE delivered_at IS NULL;
