-- ---------------------------------------------------------------------------
-- A runtime's own bill is part of the record every spend figure reads
--
-- An agent CLI reports tokens per message and its real price once, at the
-- end of the run. The engine charges an estimate for each message and, when
-- the total arrives, settles the budget accounts by the difference (0037).
-- The difference went to the accounts and to a `cost.settled` event, and
-- nowhere else -- while the monthly pause, the daily cost alert, the spend
-- circuit breaker, the cost report and the digest all read `llm_traces`.
-- Every one of them was working from the estimate, and the estimate is
-- deliberately the top of the market.
--
-- The settlement is now a trace row of its own, of kind `settlement`, whose
-- cost is the difference and may be negative. Every sum over `cost_cents`
-- that was right for calls is right for settlements too, without a second
-- source to remember; and a reader listing a task's calls can tell the two
-- apart. A call still cannot cost less than nothing.
-- ---------------------------------------------------------------------------

ALTER TABLE llm_traces
  ADD COLUMN kind text NOT NULL DEFAULT 'call',
  ADD CONSTRAINT llm_traces_kind_known CHECK (kind IN ('call', 'settlement')),
  ADD CONSTRAINT llm_traces_call_costs_something
    CHECK (kind = 'settlement' OR cost_cents >= 0),
  ADD CONSTRAINT llm_traces_settlement_has_no_tokens
    CHECK (kind = 'call' OR (input_tokens = 0 AND output_tokens = 0));
