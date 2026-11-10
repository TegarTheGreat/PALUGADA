-- WhatsApp as a customer channel: the second transport of the conversations
-- 0111 began with Telegram.
--
-- A WhatsApp Business number answers through Meta's Cloud API, and needs two
-- things a Telegram bot does not:
--
--   - account_id: the number's id in the Cloud API, which is not the number
--     itself. Every delivery names it, and one Meta app may carry several
--     numbers, so a delivery for another is not this channel's.
--   - secret_ref: the Meta app's secret, sealed like the token (`db://chat-…`).
--     Meta signs every delivery with it; there is no secret sent in a header.
--
-- For WhatsApp, webhook_hash is the hash of the verify token the owner pastes
-- into the app's webhook settings, which Meta sends back once when the
-- webhook is subscribed. `account` is the number, digits only, as customers
-- dial it.

ALTER TABLE chat_channels
  ADD COLUMN account_id text,
  ADD COLUMN secret_ref text;

ALTER TABLE chat_channels
  DROP CONSTRAINT chat_channels_kind_known,
  ADD CONSTRAINT chat_channels_kind_known CHECK (kind IN ('telegram', 'whatsapp')),
  ADD CONSTRAINT chat_channels_secret_sealed CHECK (secret_ref IS NULL OR secret_ref ~ '^db://chat-[0-9a-f]{16}$'),
  ADD CONSTRAINT chat_channels_account_id_shape CHECK (account_id IS NULL OR account_id ~ '^[0-9]{5,20}$'),
  DROP CONSTRAINT chat_channels_open_has_keys,
  ADD CONSTRAINT chat_channels_open_has_keys CHECK (NOT enabled OR (
    token_ref IS NOT NULL AND webhook_hash <> ''
    AND (kind <> 'whatsapp' OR (secret_ref IS NOT NULL AND account_id IS NOT NULL))));
