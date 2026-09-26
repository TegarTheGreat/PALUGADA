-- ---------------------------------------------------------------------------
-- An inbox item the owner has put off
--
-- The inbox had one state for "not decided yet", so an item the owner meant
-- to come back to on Monday sat at the top of the queue all weekend, in the
-- count, between them and the things that needed them today. Buzz and
-- Paperclip both let a person put something off until later.
--
-- snoozed_until: hidden from the queue and its count, and not sent to a
-- channel, until then. Never past the item's own expiry -- silence is still a
-- refusal (F10.4), and an item that expired while snoozed is one the owner
-- never saw -- so the code refuses a snooze that would outlive it.
-- ---------------------------------------------------------------------------

ALTER TABLE inbox_items ADD COLUMN snoozed_until timestamptz;
