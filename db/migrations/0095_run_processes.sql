-- ---------------------------------------------------------------------------
-- The process groups a run started, where the next worker can find them
--
-- A worker ends an agent CLI's process group when the run ends, and kills
-- every group it still holds from an exit hook. Neither runs when the worker
-- is killed with SIGKILL or by the out-of-memory killer: on a bare machine
-- -- `npm start`, with no service manager killing the worker's whole control
-- group and no container taking its processes down with it -- the CLI and
-- everything it started kept running, spending the owner's key, and nothing
-- counted it. Found by reading Paperclip, which keeps a run's pid, process
-- group and start time and kills a lost run's group after a restart.
--
-- One row per group, written as the group starts and closed when it is
-- confirmed empty. A worker sweeping its own machine (`host`: the kernel's
-- boot and the pid namespace, since a pid means nothing outside the two)
-- ends the groups whose worker is gone or silent or whose run is no longer
-- running, and only after `/proc` shows the leader still has the start time
-- written here: a pid the kernel has since given to another process is never
-- signalled (src/engine/process-ledger.ts).
--
-- `worker_pid` and `worker_started` are the worker's own process, checked
-- the same way. A worker restarted at once after being killed finds its
-- predecessor's heartbeat still fresh, and a worker id an operator fixed
-- with PALUGADA_WORKER_ID is the same id after a restart; the process is
-- what says the worker that started a group is gone.
--
-- The application role writes a row as a run starts a group and may then
-- change only `ended_at`: the sweep, which reads every company's rows on
-- this machine, runs on the control plane.
-- ---------------------------------------------------------------------------

CREATE TABLE run_processes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_run_id    uuid NOT NULL,
  worker_id       text NOT NULL,
  host            text NOT NULL,
  worker_pid      integer NOT NULL,
  worker_started  bigint NOT NULL,
  pid             integer NOT NULL,
  pgid            integer NOT NULL,
  -- Clock ticks since boot, field 22 of /proc/<pid>/stat.
  started_ticks   bigint NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  CONSTRAINT run_processes_run_fkey
    FOREIGN KEY (company_id, agent_run_id) REFERENCES agent_runs (company_id, id) ON DELETE CASCADE,
  CONSTRAINT run_processes_ids_positive
    CHECK (pid > 0 AND pgid > 0 AND worker_pid > 0 AND started_ticks >= 0 AND worker_started >= 0)
);

-- What the sweep reads: the groups on one machine that nobody has closed.
CREATE INDEX run_processes_open ON run_processes (host) WHERE ended_at IS NULL;
CREATE INDEX run_processes_by_run ON run_processes (agent_run_id);

SELECT app.enable_tenant_rls('run_processes');
REVOKE UPDATE ON run_processes FROM palugada_app;
GRANT UPDATE (ended_at) ON run_processes TO palugada_app;
