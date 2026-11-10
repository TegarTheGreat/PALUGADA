-- The owner joins the weekly meeting, and silence is never consent (F19.17).
--
-- The CEO's weekly operating meeting (F18.6) decided what was the CEO's to
-- decide and put the rest in its record for the owner to read afterwards. The
-- owner may now attend: every week, by a setting, or once, by pressing Join
-- on the meeting's card in the company room. A meeting the owner attends puts
-- its questions to the owner alone, at once, and waits for each no longer
-- than the owner said; when that time has passed the meeting goes on as one
-- without the owner would, and says so in its record.
--
--   companies.meeting_owner_joins   whether the owner attends every weekly
--                                   meeting. Off by default: attending is the
--                                   owner's choice, and it is refused while the
--                                   meeting's hour falls outside the owner's
--                                   own hours, where its questions would wait
--                                   for nobody (`meeting.outside_window`).
--   companies.meeting_join_minutes  how long each of its questions waits for
--                                   the owner: 5 to 120 minutes, 20 by default.
--
-- Written on the control plane by the rhythm route, as 0140's columns are; the
-- application role reads companies and writes none of it (0047), so an agent
-- cannot make the owner attend, nor shorten the wait its questions get.
ALTER TABLE companies
  ADD COLUMN meeting_owner_joins boolean NOT NULL DEFAULT false,
  ADD COLUMN meeting_join_minutes smallint NOT NULL DEFAULT 20
    CONSTRAINT companies_meeting_join_bounded CHECK (meeting_join_minutes BETWEEN 5 AND 120);

COMMENT ON COLUMN companies.meeting_owner_joins IS
  'F19.17: whether the owner attends the weekly operating meeting, whose questions then wait for the owner alone.';
COMMENT ON COLUMN companies.meeting_join_minutes IS
  'F19.17: how long, 5 to 120 minutes, each question of a meeting the owner attends waits before the meeting goes on.';

-- What an unanswered item does when its time is up. `cancel` is what every
-- item has always done (F10.4): an approval nobody answered is refused, and
-- the work it was for is cancelled. `continue` is only ever a run's own
-- question (`owner.ask`, an escalation the run asked), and only the timed
-- question of a meeting the owner attends asks for it: when its minutes have
-- passed, the meeting goes on without the answer. The second check is the
-- line that matters. Silence never approves anything, so no approval, and no
-- escalation the platform raised, can ever be made to go on by itself. An
-- item whose payload names no asker is not a run's question: the comparison
-- is made false rather than left NULL, which a CHECK would let through.
ALTER TABLE inbox_items
  ADD COLUMN on_expiry text NOT NULL DEFAULT 'cancel'
    CONSTRAINT inbox_on_expiry_known CHECK (on_expiry IN ('cancel', 'continue')),
  ADD CONSTRAINT inbox_continue_only_questions
    CHECK (on_expiry = 'cancel' OR (kind = 'escalation' AND coalesce(payload->>'askedBy' = 'agent', false)));

COMMENT ON COLUMN inbox_items.on_expiry IS
  'F19.17: cancel, as every item; or continue, only for a run''s question in a meeting the owner attends, which goes on unanswered.';
