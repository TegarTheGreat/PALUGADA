-- How long one run of a role may take (#102).
--
-- A run that kept going was bounded only by its task's deadline, and most
-- tasks have none: the lease keeper renews a lease for as long as a run
-- shows progress, so an agent CLI working an hour on a ten-minute job spent
-- an hour of tokens before anything looked at the clock. The owner now says,
-- per role, how long a run may take; past it the run is stopped, what it
-- committed is kept, and the attempt counts. Null is no limit beyond the
-- task's own deadline, which is how every role ran before.
--
-- In seconds, so a limit is exact; the console asks in minutes. At most a
-- day: a run longer than that is work for a schedule, not one run.
ALTER TABLE roles
  ADD COLUMN max_run_seconds integer
    CONSTRAINT roles_max_run_seconds_range CHECK (max_run_seconds BETWEEN 1 AND 86400);
