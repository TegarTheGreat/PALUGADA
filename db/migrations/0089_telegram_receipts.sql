-- Which Telegram updates were taken in, kept where every process sees them.
--
-- The channel remembered update ids in its own memory, so an update
-- Telegram sent again after a restart, or to another replica behind the same
-- address, was handled again. A decision was not repeated -- its item was
-- already closed -- but the owner's words to the CEO were said twice, and
-- answered twice. The same as WhatsApp's receipts (0085), keyed by the bot
-- as well, since update ids are counted per bot.

CREATE TABLE telegram_receipts (
  update_key   text PRIMARY KEY,
  received_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT telegram_receipts_key_size CHECK (length(update_key) BETWEEN 1 AND 64)
);
CREATE INDEX telegram_receipts_received ON telegram_receipts (received_at);

GRANT SELECT, INSERT, DELETE ON telegram_receipts TO palugada_admin;
