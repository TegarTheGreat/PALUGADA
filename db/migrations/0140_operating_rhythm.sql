-- The weekly operating meeting, held by the CEO at the owner's hour (F18.6).
--
-- A company of agents had a scorecard, quarterly priorities, an issues list
-- and to-dos, and nothing that looked at them together once a week. The
-- meeting is a task the platform makes for the CEO (src/engine/meeting.ts),
-- once per ISO week in the company's time zone, from facts it reads from the
-- rows (src/reporting/meeting.ts). It needs no table of its own: the task,
-- its input and its output are the record (STATUS 2.189).
--
-- What the owner chooses is when it is held, and whether it is: three
-- columns on the company, since there is one meeting a company.
--
--   meeting_weekday  the day of the week, 0 Sunday to 6 Saturday, as
--                    PostgreSQL's `dow` and JavaScript's getDay count it.
--                    Monday by default, the start of the ISO week the meeting
--                    is keyed by.
--   meeting_hour     the hour, 0 to 23, on the company's clock. Nine by
--                    default: after the operating kit's weekly business
--                    review at 07:45, so the meeting can read it.
--   meeting_enabled  whether it is held. On by default, because a company
--                    with nothing to review spends nothing on it (F9.10):
--                    the meeting is not made at all that week.
--
-- The application role reads them and writes none of them (0047 took UPDATE
-- on companies away): an agent that could move or cancel the meeting could
-- choose not to be reviewed. The owner sets them on the control plane.

ALTER TABLE companies
  ADD COLUMN meeting_weekday smallint NOT NULL DEFAULT 1,
  ADD COLUMN meeting_hour    smallint NOT NULL DEFAULT 9,
  ADD COLUMN meeting_enabled boolean  NOT NULL DEFAULT true,
  ADD CONSTRAINT companies_meeting_weekday_known CHECK (meeting_weekday BETWEEN 0 AND 6),
  ADD CONSTRAINT companies_meeting_hour_known CHECK (meeting_hour BETWEEN 0 AND 23);

COMMENT ON COLUMN companies.meeting_weekday IS
  'F18.6: the day of the weekly operating meeting, 0 Sunday to 6 Saturday, in the company''s time zone.';
COMMENT ON COLUMN companies.meeting_hour IS
  'F18.6: the hour of the weekly operating meeting, 0 to 23, in the company''s time zone.';
COMMENT ON COLUMN companies.meeting_enabled IS
  'F18.6: whether the CEO holds the weekly operating meeting at all.';
