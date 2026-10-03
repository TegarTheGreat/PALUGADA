-- ---------------------------------------------------------------------------
-- Retention reaches the work itself (M10)
--
-- Retention scrubbed prompts and replies and purged events, traces and the
-- platform's bookkeeping at the company's windows (0007, 0046). The work
-- those records were about -- `tasks`, and with each its journal steps, its
-- runs and its inbox cards -- was never removed: a row for every task, every
-- step with what it was given and what it returned, and every card, for
-- ever, past the windows that had removed everything said about them.
--
-- Retention now removes finished work once both windows have passed it, and
-- a closed card that belonged to no task at the event window. It is logged
-- like the rest, which needs one more name for what was done.
-- ---------------------------------------------------------------------------

ALTER TABLE retention_log
  DROP CONSTRAINT retention_action_known,
  ADD CONSTRAINT retention_action_known
    CHECK (action IN ('events_purged', 'traces_purged', 'prompts_scrubbed',
                      'journal_scrubbed', 'bookkeeping_purged', 'work_purged'));

-- Removing a task makes the database find every row that points at it, in
-- each table that does. These tables grow with the work and had no index on
-- the column it searches, so each task removed read the whole of each.
CREATE INDEX inbox_items_task_idx ON inbox_items (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX llm_traces_agent_run_idx ON llm_traces (agent_run_id) WHERE agent_run_id IS NOT NULL;
CREATE INDEX owner_notifications_task_idx ON owner_notifications (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX task_handoffs_to_task_idx ON task_handoffs (to_task_id) WHERE to_task_id IS NOT NULL;
CREATE INDEX memories_source_task_idx ON memories (source_task_id) WHERE source_task_id IS NOT NULL;
CREATE INDEX decision_records_task_idx ON decision_records (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX metric_observations_task_idx ON metric_observations (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX trigger_deliveries_task_idx ON trigger_deliveries (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX whatsapp_sent_item_idx ON whatsapp_sent (item_id);
