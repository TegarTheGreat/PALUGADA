-- The authenticator is asked for when the owner signs in, and not again (the
-- owner's report of 7 October: "buat agar autentikator saat login saja").
--
-- 0120 gave the owner a window of minutes in which what builds the company
-- needed no new code, and a setting for how long. A session opened with a
-- code or a passkey is now the second factor for everything the console does
-- except what changes who the owner is, so there is no window to set:
-- `step_up_minutes` goes. `owner_sessions.proved_at` stays, with a plainer
-- meaning: when the session last showed a device's code or passkey, which is
-- when it was opened for a session signed in with one, and null for one
-- signed in with a recovery code until a device's code is shown in it.
ALTER TABLE platform_control
  DROP CONSTRAINT platform_control_step_up_range,
  DROP COLUMN step_up_minutes;
