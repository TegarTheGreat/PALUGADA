-- The cards raised before they said what period they are about.
--
-- A day's card closes once its day has ended and the owner has had it a whole
-- day (`closeEndedDays`, alerts.ts), and the 80% warning once its month has
-- ended (`withdrawEarlierWarnings`, spend-guard.ts). Each close reads the
-- period from the card's payload, which the code before them left empty: a
-- deployment upgraded with those cards open kept them for good, the backlog
-- the closes were written to clear ("a busy month left thirty"). The daily
-- counts that code raised as incidents -- read-backs that failed, checks that
-- failed, workers that stopped -- are raised no more, each said where it can
-- be acted on, and nothing would ever close one left open.
--
-- So the old cards are labelled as the code labels new ones, and the next look
-- closes them as it closes those; the old counts are closed now, with the
-- event the code writes when it withdraws a card.
--
-- Reading and writing every company's rows as the tables' owner is refused by
-- forced row security without a tenant: lifted for this transaction, and put
-- back before it ends (as 0133).
ALTER TABLE inbox_items NO FORCE ROW LEVEL SECURITY;
ALTER TABLE events NO FORCE ROW LEVEL SECURITY;

-- A day's card is named by the `alert.raised` the code wrote with it, which
-- says its kind. Its day is the day it was raised, read as `claimAlertSlot`
-- and `closeEndedDays` read a day: in the database's time zone.
UPDATE inbox_items i
   SET payload = i.payload || jsonb_build_object(
         'alert', e.payload->>'kind', 'day', to_char(date_trunc('day', i.created_at), 'YYYY-MM-DD'))
  FROM events e
 WHERE e.company_id = i.company_id AND e.type = 'alert.raised'
   AND e.payload->>'inboxItemId' = i.id::text
   AND i.kind = 'budget_alert' AND i.status = 'open' AND NOT i.payload ? 'alert';

-- An incident an alert raised is one of the daily counts: every alert the
-- code raises now is a budget card.
WITH closed AS (
  UPDATE inbox_items i SET status = 'withdrawn', closed_reason = 'day_ended'
    FROM events e
   WHERE e.company_id = i.company_id AND e.type = 'alert.raised'
     AND e.payload->>'inboxItemId' = i.id::text
     AND i.kind = 'incident' AND i.status = 'open'
  RETURNING i.id, i.company_id
)
INSERT INTO events (company_id, type, actor, payload)
SELECT company_id, 'inbox.withdrawn', 'system', jsonb_build_object('inboxItemId', id, 'closedReason', 'day_ended')
  FROM closed;

-- What is left of the budget cards with no task and nothing in their payload
-- is the 80% warning: the daily cards are labelled above, the pause card is
-- matched by its English title where it closes (`PAUSED_TITLE`), and every
-- other budget card names its task. Its month is UTC's, as `periodBounds`
-- counts one, written as `toISOString` writes its start: the close compares
-- the two as text. A day's card whose `alert.raised` retention has since
-- removed reads the same; it is a year old at least, so its month has ended
-- as surely as its day, and it closes as a month's card.
UPDATE inbox_items
   SET payload = jsonb_build_object('spendWarning', jsonb_build_object(
         'periodStart', to_char(date_trunc('month', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
 WHERE kind = 'budget_alert' AND status = 'open' AND task_id IS NULL AND payload = '{}'::jsonb
   AND title <> 'Monthly budget reached; the company is paused';

ALTER TABLE events FORCE ROW LEVEL SECURITY;
ALTER TABLE inbox_items FORCE ROW LEVEL SECURITY;
