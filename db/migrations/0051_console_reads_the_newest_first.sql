-- ---------------------------------------------------------------------------
-- The console reads a company's newest events and newest tasks
--
-- The owner's console now shows what happened lately and the work in
-- progress, both newest first and bounded. Neither had an index that serves
-- it: `events` was indexed by task and by (company, type), `tasks` by the
-- statuses a worker claims from. Without these, every page load sorts a
-- company's whole history to show its top thirty rows -- and `events` is the
-- table that only ever grows.
-- ---------------------------------------------------------------------------

CREATE INDEX events_company_recent_idx ON events (company_id, occurred_at DESC);
CREATE INDEX tasks_company_recent_idx ON tasks (company_id, created_at DESC);
