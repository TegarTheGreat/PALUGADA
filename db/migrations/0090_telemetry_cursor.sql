-- Which finished runs have gone to the OpenTelemetry collector (the
-- competitive analysis of 2026-09-30, item 13): the last one sent, by its
-- finish and its id, and which process holds the right to send the next
-- batch. One row. Kept here rather than in a process, so replicas do not
-- send a run twice and a restart does not skip one.

CREATE TABLE telemetry_cursor (
  id          boolean PRIMARY KEY DEFAULT true CHECK (id),
  through_at  timestamptz NOT NULL DEFAULT '-infinity',
  through_id  uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  holder      text,
  held_until  timestamptz NOT NULL DEFAULT '-infinity'
);
INSERT INTO telemetry_cursor DEFAULT VALUES;

GRANT SELECT, UPDATE ON telemetry_cursor TO palugada_admin;
