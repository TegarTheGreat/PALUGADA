-- ---------------------------------------------------------------------------
-- A schedule that cannot fire says so once, not every five seconds (F9.1)
--
-- `runDueSchedules` deliberately leaves a schedule that could not create its
-- task where it is, so the occurrence is retried on the next pass -- the
-- right answer for the usual cause, a budget that is exhausted until the owner
-- raises it. And it records the failure, so the occurrence does not vanish.
-- Both on every pass: the worker ticks every few seconds, so one schedule in a
-- company whose spend is paused wrote `schedule.fire_failed` about seventeen
-- thousand times a day, into an append-only log that retention keeps for a
-- year. Slack's lesson about notification volume applies to an audit trail
-- too: a log that says the same thing every five seconds is one nobody reads.
--
-- So the schedule remembers which occurrence last failed and why. The event
-- is written when that changes -- a new occurrence failing, or the same one
-- failing for a different reason -- and the retry still happens every pass.
-- A successful fire clears it.
-- ---------------------------------------------------------------------------

ALTER TABLE schedules
  ADD COLUMN fire_failed_for timestamptz,
  ADD COLUMN fire_failure text;
