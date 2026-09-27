-- Where a memory came from, and whether it came from outside.
--
-- The company learned from its event log, and the events of finished work
-- carried nothing but their type: a distilled "fact" was a model's guess at
-- metadata, stored active at once, at whatever confidence the model named,
-- and read back to every run in the division as a Known fact -- even when
-- the work it came from had read a customer's email or a web page. A fact
-- said again was a second fact. These columns let the company learn from the
-- work itself and keep track of how much each lesson is worth:
--
-- `outside`: it came, however indirectly, from content the company did not
-- write (F8.9). Such a memory is never presented to a run as a known fact;
-- it is shown as data, like the page it came from.
--
-- `source_task_id`: the finished work that taught it, for the owner's
-- "why does the company believe this".
--
-- `reinforced_count`, `last_reinforced_at`: the same lesson learned again
-- strengthens the one row instead of adding another.

ALTER TABLE memories ADD COLUMN outside boolean NOT NULL DEFAULT false;
ALTER TABLE memories ADD COLUMN source_task_id uuid;
ALTER TABLE memories ADD COLUMN reinforced_count integer NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN last_reinforced_at timestamptz;

-- NOT VALID because every existing row is null here, and validating would
-- read the rows as the table's owner, whom row security refuses (0049).
ALTER TABLE memories ADD CONSTRAINT memories_source_task_fkey
  FOREIGN KEY (company_id, source_task_id) REFERENCES tasks (company_id, id) ON DELETE SET NULL (source_task_id) NOT VALID;
ALTER TABLE memories ADD CONSTRAINT memories_reinforced_count_positive CHECK (reinforced_count >= 0);

-- A memory is a fact or a way to work, not a document: a price list pasted
-- whole belongs in a file. Checked for what is written from now on; a
-- longer row written before this stays as it was.
ALTER TABLE memories ADD CONSTRAINT memories_body_size CHECK (length(body) <= 8000) NOT VALID;
