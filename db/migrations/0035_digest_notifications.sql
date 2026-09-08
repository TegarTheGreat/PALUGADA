-- ---------------------------------------------------------------------------
-- The daily digest is a delivery too (PRD v2 F10.6)
--
-- `renderDailyDigest` turned a digest into text and nothing sent it: the
-- console draws its own, so an owner looking at the console saw one and an
-- owner who was not looking never did. F10.6 asks for a digest, not for a
-- panel.
--
-- Sending it needs the same exactly-once record every other delivery here
-- uses, and a digest is not an inbox item -- it has no id, and nothing decides
-- it. So `inbox_item_id` becomes nullable and a `digest_day` takes its place
-- as what makes the row unique. A worker restarted twice in an afternoon sends
-- one digest, and the constraint is what enforces that rather than a read
-- followed by a write.
-- ---------------------------------------------------------------------------

ALTER TABLE owner_notifications
  ALTER COLUMN inbox_item_id DROP NOT NULL,
  ADD COLUMN digest_day date;

-- Exactly one of the two, and never neither. A row with both would be an item
-- delivery pretending to be a digest; a row with neither is a delivery of
-- nothing, which is the shape a bug takes when a caller forgets an argument.
ALTER TABLE owner_notifications
  ADD CONSTRAINT owner_notifications_item_or_digest
  CHECK ((inbox_item_id IS NULL) <> (digest_day IS NULL));

-- The uniqueness that makes "once a day per channel" true. Partial, because
-- the existing (inbox_item_id, channel) key already covers item deliveries and
-- a NULL there would not collide with itself.
CREATE UNIQUE INDEX owner_notifications_digest_key
  ON owner_notifications (company_id, channel, digest_day)
  WHERE digest_day IS NOT NULL;
