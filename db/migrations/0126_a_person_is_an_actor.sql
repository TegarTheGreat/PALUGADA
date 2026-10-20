-- A person is an actor (the audit of 6 October, §8.2, P1.1).
--
-- The owner was the only person a run could ask, and the answer was a string.
-- Four things on the question the platform already has, made here together
-- because they are one design; each is used by its own step.
--
--   addressee_seat   whom a question is for: a staff seat, or nobody in
--                    particular (null), which is the owner's and any approver's
--                    as it was. The seat is not a foreign key: seats are the
--                    control plane's alone (0110), and `decided_by_seat` is
--                    kept the same way, so the record outlives the seat.
--   escalate_at      when an unanswered question for a seat goes to the owner;
--   escalated_at     when it did, so it is done once.
--   answer_files     the files an answer carried, kept in the company's files
--                    (`[{ kind, name, path, bytes }]`, at most five).
ALTER TABLE inbox_items
  ADD COLUMN addressee_seat uuid,
  ADD COLUMN escalate_at timestamptz,
  ADD COLUMN escalated_at timestamptz,
  ADD COLUMN answer_files jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT inbox_answer_files_bounded CHECK (
    jsonb_typeof(answer_files) = 'array' AND jsonb_array_length(answer_files) <= 5 AND pg_column_size(answer_files) <= 8192
  );

-- What the seat's own view and the sweep read: open items with an addressee.
CREATE INDEX inbox_addressed_open ON inbox_items (company_id, addressee_seat)
  WHERE status = 'open' AND addressee_seat IS NOT NULL;
CREATE INDEX inbox_to_escalate ON inbox_items (escalate_at)
  WHERE status = 'open' AND escalate_at IS NOT NULL AND escalated_at IS NULL;
