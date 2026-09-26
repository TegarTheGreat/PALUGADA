-- ---------------------------------------------------------------------------
-- Retention reaches the journal and the bookkeeping tables
--
-- Retention scrubbed prompts from `llm_traces` at ninety days (F11.5) and
-- purged traces and events at the company's windows, and touched nothing
-- else. Two consequences:
--
--   - A model's reply is also the output of the `llm` step that asked for it,
--     in `task_steps`, where it stayed for ever. The ninety-day rule held for
--     one copy of every response and not the other.
--   - The tables that record how the platform got something done -- which
--     notifications went out, which wakes were consumed, which device
--     challenges were issued and which requests were already answered, how
--     each eval run went -- grew by a row for every such thing and never
--     shrank.
--
-- So retention now scrubs a finished task's model replies from its journal at
-- the prompt window, and purges that bookkeeping at the event window. Both
-- are logged like the rest, which needs two more names for what was done.
-- ---------------------------------------------------------------------------

ALTER TABLE retention_log
  DROP CONSTRAINT retention_action_known,
  ADD CONSTRAINT retention_action_known
    CHECK (action IN ('events_purged', 'traces_purged', 'prompts_scrubbed',
                      'journal_scrubbed', 'bookkeeping_purged'));
