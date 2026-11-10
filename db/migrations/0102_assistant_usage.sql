-- What a conversation with the owner's assistant cost (N8).
--
-- The engine traces the model calls of tasks, and the owner's conversations
-- are not tasks: on the live run of 2 October three conversations with a
-- company's CEO, one of them thirty-nine seconds of several turns, left no
-- trace at all, and the month's ceiling, the daily cost alert, the digest
-- and the Money page were all short by what they cost. A CEO's turns are
-- now traces of its company, outside any task, like the company's memory
-- being distilled.
--
-- PALUGADA's own assistant belongs to no company, and `llm_traces` is a
-- tenant table: a call there is some company's. So what an answer cost is
-- kept with the answer, here, for the deployment's own figure beside the
-- companies'. A CEO's answer keeps it too, as the sum of the traces its
-- company was charged.

ALTER TABLE assistant_messages
  ADD COLUMN model text,
  ADD COLUMN input_tokens integer NOT NULL DEFAULT 0,
  ADD COLUMN output_tokens integer NOT NULL DEFAULT 0,
  ADD COLUMN cost_cents integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT assistant_messages_usage_counts
    CHECK (input_tokens >= 0 AND output_tokens >= 0 AND cost_cents >= 0);
