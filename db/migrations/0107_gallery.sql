-- The gallery of what a company produced (the analysis of 3 October, §9 P1
-- item 12): every document and email its tasks committed for a person to
-- read, newest first, across the whole company.
--
-- They are journal steps (task_steps): a capability's committed result that
-- names a path and holds the text. Reading them for one task walks the
-- task's own steps by the primary key; reading them for a company, newest
-- first and a page at a time, would walk every step the company ever took.
-- This index holds only the steps a gallery shows, in its order, and its
-- condition is the one the gallery asks (src/owner/views.ts, galleryOf).

CREATE INDEX task_steps_gallery
  ON task_steps (company_id, committed_at DESC, task_id DESC, step_index DESC)
  WHERE status = 'committed'
    AND name LIKE 'capability:%'
    AND jsonb_typeof(output -> 'path') = 'string';
