-- Phase 4 (PRD v2): a trace whose prompt the platform never saw (F11.1, NG6).

-- ---------------------------------------------------------------------------
-- NG6 moves the model call into the runtime, so the prompt belongs to the
-- runtime. F11.1 asks for it to be traced *through the adapter*, which means a
-- runtime that shares it gets it recorded and one that does not, does not.
--
-- NULL is therefore a real state now, and it is not the same as a scrubbed
-- prompt. "The runtime never told us" and "it was here and retention removed
-- it" are different facts about the same row, and an auditor asking why a
-- prompt is missing needs them told apart. The scrubber writes its own marker
-- and now leaves a NULL alone.
-- ---------------------------------------------------------------------------
ALTER TABLE llm_traces ALTER COLUMN prompt DROP NOT NULL;

COMMENT ON COLUMN llm_traces.prompt IS
  'NULL means the runtime did not share it (F11.1 traces what the adapter '
  'reports). The marker {"redacted":"retention"} means it was here and F11.5 '
  'removed it. Those are different answers to "why is this empty".';
