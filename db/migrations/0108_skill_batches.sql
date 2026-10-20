-- A bundle's skills are reviewed together and put to the owner together (B9).
--
-- A company made from company-os opened with eleven skill cards in the
-- owner's inbox before they had asked for anything, each after a reviewer
-- run of its own. The skills a bundle brings arrived together and are
-- decided together: one review reads them all and gives a verdict on each,
-- and one card asks the owner about every one the review approved.
--
-- `batch` is what they arrived in, one value per install of a bundle;
-- `batch_name` is what the owner calls it -- the bundle's name, which the
-- application role cannot read from `bundles` -- for the card. A version
-- proposed on its own has neither and is reviewed and asked about alone.

ALTER TABLE skill_versions ADD COLUMN batch uuid;
ALTER TABLE skill_versions ADD COLUMN batch_name text;
ALTER TABLE skill_versions ADD CONSTRAINT skill_versions_batch_name_size
  CHECK (batch_name IS NULL OR length(batch_name) <= 200);
ALTER TABLE skill_versions ADD CONSTRAINT skill_versions_batch_named
  CHECK ((batch IS NULL) = (batch_name IS NULL));

-- One review now reads a whole batch, so a review task is no longer one
-- version's alone (0072). That a version is given to a review once is kept
-- by the update that records it, which only takes a version no review has.
DROP INDEX skill_versions_one_review_task;
CREATE INDEX skill_versions_review_task ON skill_versions (review_task_id) WHERE review_task_id IS NOT NULL;
CREATE INDEX skill_versions_batch ON skill_versions (batch) WHERE batch IS NOT NULL;
