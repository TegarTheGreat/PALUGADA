-- F5.7 (0091): calls in flight at once are places, one row each, made the
-- first time they are wanted. Nothing bounded how many a grant could ask
-- for, so a limit of 2147483647 made the first call insert as many rows.
-- `MAX_IN_FLIGHT` in src/broker/in-flight.ts is the same bound.
--
-- NOT VALID: a grant already above it keeps working, clamped by the broker,
-- until it is next changed; every write from now on is held to it.
ALTER TABLE capability_grants
  ADD CONSTRAINT capability_grants_max_in_flight_bounded
    CHECK (max_in_flight IS NULL OR max_in_flight <= 100) NOT VALID;
