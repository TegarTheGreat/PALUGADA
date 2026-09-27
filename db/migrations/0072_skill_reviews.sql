-- A skill candidate is reviewed by a role, as work.
--
-- F15.3 puts two gates in front of a skill: an adversarial review by another
-- role, then the owner. The second gate was reached through the inbox, and
-- approving there did nothing; the first was reached by nobody, so the only
-- way a candidate ever became live was the owner marking it reviewed
-- themselves on a form that asked them to paste its id -- the owner being the
-- review, which is the arrangement F7 exists to avoid.
--
-- A candidate that passes its own eval cases is now given to a reviewer role
-- as a task. `review_task_id` is that task, so the owner can read the review
-- and a worker never opens a second one; `review_note` is what the reviewer
-- said when it approved, which the owner reads before they decide.

ALTER TABLE skill_versions ADD COLUMN review_task_id uuid;
ALTER TABLE skill_versions ADD COLUMN review_note text;

-- NOT VALID because every existing row is null here, and validating would
-- read the rows as the table's owner, whom row security refuses (0049).
ALTER TABLE skill_versions ADD CONSTRAINT skill_versions_review_task_fkey
  FOREIGN KEY (company_id, review_task_id) REFERENCES tasks (company_id, id)
  ON DELETE SET NULL (review_task_id) NOT VALID;

-- One review per version: two workers settling the same candidate must not
-- give it to the reviewer twice.
CREATE UNIQUE INDEX skill_versions_one_review_task
  ON skill_versions (review_task_id) WHERE review_task_id IS NOT NULL;

ALTER TABLE skill_versions ADD CONSTRAINT skill_versions_review_note_size
  CHECK (review_note IS NULL OR length(review_note) <= 2000);

-- A question already in an owner's inbox about a version no reviewer has
-- read could only be refused: withdrawn, and asked again once the review
-- approves it. Row security is lifted for the update and restored, as 0068
-- does, because a migration runs as the table's owner.
CREATE TEMPORARY TABLE forced_row_security ON COMMIT DROP AS
  SELECT oid::regclass AS target FROM pg_class
   WHERE relforcerowsecurity AND relnamespace = 'public'::regnamespace;

DO $$
DECLARE target regclass;
BEGIN
  FOR target IN SELECT forced_row_security.target FROM forced_row_security LOOP
    EXECUTE format('ALTER TABLE %s NO FORCE ROW LEVEL SECURITY', target);
  END LOOP;
END $$;

UPDATE inbox_items item
   SET status = 'withdrawn', closed_reason = 'sent_for_review'
 WHERE item.kind = 'skill_candidate' AND item.status = 'open'
   AND NOT EXISTS (SELECT 1 FROM skill_versions v
                    WHERE v.id::text = item.payload->>'skillVersionId'
                      AND v.state = 'candidate' AND v.reviewed_at IS NOT NULL);

DO $$
DECLARE target regclass;
BEGIN
  FOR target IN SELECT forced_row_security.target FROM forced_row_security LOOP
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
  END LOOP;
END $$;
