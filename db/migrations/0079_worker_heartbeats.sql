-- Workers say they are alive.
--
-- A lease is a deadline the database holds, and a worker that dies releases
-- nothing, so its tasks came back only when their leases ran out: fifteen
-- minutes, in a chaos run that killed a worker in the middle of a vendor
-- call and restarted it at once. The restarted worker sat beside a task
-- leased to a process that no longer existed. Each worker now writes here
-- every few seconds; one that has gone quiet has its tasks returned without
-- waiting out their leases, which stay the backstop for a holder that never
-- wrote here at all.
--
-- The platform's, like the migrations table: no company's data, no row
-- security, and no grant to the application role. The sweep reads it on the
-- control plane and hands the quiet holders to the tenant query.
CREATE TABLE worker_heartbeats (
  worker_id   text PRIMARY KEY,
  started_at  timestamptz NOT NULL DEFAULT now(),
  beat_at     timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON worker_heartbeats TO palugada_admin;
