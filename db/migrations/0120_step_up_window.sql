-- One code opens a short window (the owner's complaint of 6 October).
--
-- Every change to the company's structure asked for a fresh second factor,
-- which is single use: building a company was the phone out for each
-- division, role and goal. A session now remembers when its owner last
-- proved themselves -- at sign-in, and each time a code or passkey is shown
-- for an action -- and for the minutes the owner chooses, what builds the
-- company needs no new one. What loosens money, reaches outside, changes the
-- model or a key, touches the owner's own devices, or decides a tier 3 item
-- is not covered by it (src/owner/api.ts, `WITHIN_THE_WINDOW`).
--
-- A recovery code proves less than a device and signs in without opening
-- one: `proved_at` stays null for it.
ALTER TABLE owner_sessions ADD COLUMN proved_at timestamptz;

-- Ten minutes unless the owner says otherwise; none asks every time.
ALTER TABLE platform_control
  ADD COLUMN step_up_minutes integer NOT NULL DEFAULT 10,
  ADD CONSTRAINT platform_control_step_up_range CHECK (step_up_minutes IN (0, 5, 10, 30, 60));
