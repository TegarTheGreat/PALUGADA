-- What each step was asked to do, beside what it returned.
--
-- The journal kept a step's output and only a hash of its input, so the
-- owner reading a task's trace saw that `email.send` ran and what came back,
-- and not to whom or with what -- the half of the record that says whether
-- the action was the right one. Tool and internal steps keep their input
-- now, bounded by the journal; a model call's input is its prompt, which
-- llm_traces already keeps under its own retention (F11.5).

ALTER TABLE task_steps ADD COLUMN input jsonb;
