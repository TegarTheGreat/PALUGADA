-- An erasure that fails is kept on the company, and tried again later
-- (read in Buzz's source, 2026-09-30).
--
-- The worker erased the due companies in order, and the first one that
-- failed -- a trigger refusing, a statement timing out on a large company --
-- stopped every company after it, on every tick, with nothing to show for it
-- but a count of stage failures. Each company is erased on its own now, and
-- one that fails says so here: how many times it has been tried, what the
-- last try said, and when it is tried again. Waiting between tries, longer
-- each time, keeps a failure that needs a person from being retried and
-- logged every few seconds for as long as it takes them to come.
--
-- On the company's own row, so they go with it when it is finally erased,
-- and a kept company carries nothing of an erasure it is no longer due.

ALTER TABLE companies
  ADD COLUMN erase_attempts integer NOT NULL DEFAULT 0 CONSTRAINT companies_erase_attempts_counted CHECK (erase_attempts >= 0),
  ADD COLUMN erase_failure  text,
  ADD COLUMN erase_retry_at timestamptz,
  ADD CONSTRAINT companies_erase_failure_while_closing
    CHECK (erase_after IS NOT NULL OR (erase_attempts = 0 AND erase_failure IS NULL AND erase_retry_at IS NULL));
