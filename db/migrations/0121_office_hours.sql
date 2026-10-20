-- A company that keeps office hours (STATUS 2.150).
--
-- F9.6 stands: agents have no working hours. What a company can ask is that the
-- things which reach the outside world -- an email sent, a customer answered, a
-- post published -- wait for the morning, which the broker already did for one
-- capability at a time (`capability_windows`) when someone typed the row into
-- the database. This is the same rule said once for the company, by the owner,
-- in the console.
--
-- A window only ever defers: the action is as permitted as it was, at another
-- hour. So clearing hours, or widening them, loosens nothing a policy or an
-- approval decides, and the owner's session is enough to set them.
CREATE TABLE office_hours (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  timezone     text NOT NULL,
  -- Half-open [start, end) in the zone, and a start after the end wraps past
  -- midnight; an end of 24 is the end of the day.
  start_hour   smallint NOT NULL,
  end_hour     smallint NOT NULL,
  days_of_week smallint[] NOT NULL DEFAULT '{1,2,3,4,5}',
  -- Capabilities the owner keeps open round the clock -- a customer answered
  -- at any hour, say -- by name.
  except_capabilities text[] NOT NULL DEFAULT '{}',
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT office_hours_in_range CHECK (start_hour BETWEEN 0 AND 23 AND end_hour BETWEEN 0 AND 24),
  CONSTRAINT office_hours_differ CHECK (start_hour <> end_hour),
  -- A day set that names no day, or one that is not a day, would never open.
  CONSTRAINT office_hours_days CHECK (
    cardinality(days_of_week) BETWEEN 1 AND 7
    AND days_of_week <@ ARRAY[0, 1, 2, 3, 4, 5, 6]::smallint[])
);
SELECT app.enable_tenant_rls('office_hours');
-- What holds an agent's action to the hours is not the agent's to change: the
-- application role reads them, and only the owner's console writes them.
REVOKE INSERT, UPDATE ON office_hours FROM palugada_app;
