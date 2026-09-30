-- F5.7, its second half: how many calls to one capability a division may
-- have in flight at once, counted the same by every worker.
--
-- A division's own limit on tasks at once is kept by the claim. A vendor's
-- limit is on calls: an image model on one GPU, an API that refuses a second
-- request while the first is running, a deploy that must not overlap another.
-- An hourly rate says nothing about overlap, so a grant can now say
-- `max_in_flight` beside `rate_limit_per_hour`, and it holds across replicas
-- because the places are rows here rather than counters in a process.
ALTER TABLE capability_grants
  ADD COLUMN max_in_flight integer,
  ADD CONSTRAINT capability_grants_max_in_flight_positive
    CHECK (max_in_flight IS NULL OR max_in_flight > 0);

-- One row per place: a grant allowing three has places 1, 2 and 3, made the
-- first time they are wanted. A call takes a free place by writing itself
-- into it and gives it back by clearing it, so the table never grows past
-- the sum of the limits and the application role never deletes from it
-- (0047). A place is also free when whoever holds it has lost the task's
-- lease -- a worker that died mid-call gives its place back when its lease
-- lapses -- and a call made outside any lease holds it for fifteen minutes
-- at most (src/broker/in-flight.ts).
CREATE TABLE capability_places (
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  division_id      uuid NOT NULL,
  capability_name  text NOT NULL,
  place            integer NOT NULL,
  task_id          uuid,
  -- The call's own idempotency key, which is how it gives the place back.
  holder_key       text,
  -- The task's lease holder when the call took the place.
  lease_holder     text,
  taken_at         timestamptz,
  PRIMARY KEY (company_id, division_id, capability_name, place),
  FOREIGN KEY (company_id, division_id) REFERENCES divisions (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, task_id) REFERENCES tasks (company_id, id) ON DELETE CASCADE,
  CONSTRAINT capability_places_numbered CHECK (place > 0),
  CONSTRAINT capability_places_held_whole
    CHECK ((holder_key IS NULL) = (taken_at IS NULL) AND (holder_key IS NULL OR task_id IS NOT NULL))
);

SELECT app.enable_tenant_rls('capability_places');
