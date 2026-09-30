-- WhatsApp as the owner's channel (F10.9), through Meta's Cloud API.
--
-- Two things the channel has to remember across a restart, and a third place
-- the owner's conversation can come from.
--
-- 1. Which inbound messages it has already acted on. Meta sends a delivery
--    again when it did not see it answered in time, and keeps trying for
--    days: a press recognised only in memory would decide twice after a
--    restart, and a question would be asked twice. Keyed on WhatsApp's own
--    message id, kept a fortnight, which is longer than Meta retries.
--
-- 2. What it sent, for the two answers that arrive later. A reply to an "Ask"
--    prompt names only the prompt's message id, so the prompt's item is kept
--    against it. And a message outside WhatsApp's 24-hour window is accepted
--    by the send call and reported failed afterwards, in a status delivery;
--    the item it was is kept so it can go as the approved template instead,
--    and be sent again with its buttons once the owner writes back.
--
-- Both belong to the owner and no company, like the owner's conversation
-- (0066) and the Telegram topics (0077): no row security, and no grant to the
-- application role.

CREATE TABLE whatsapp_receipts (
  message_id   text PRIMARY KEY,
  received_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_receipts_id_size CHECK (length(message_id) BETWEEN 1 AND 256)
);
CREATE INDEX whatsapp_receipts_received ON whatsapp_receipts (received_at);

CREATE TABLE whatsapp_sent (
  message_id   text PRIMARY KEY,
  company_id   uuid REFERENCES companies (id) ON DELETE CASCADE,
  item_id      uuid,
  -- An item with buttons; a prompt for the owner's question or answer about
  -- one; anything else (a notice, a digest).
  purpose      text NOT NULL,
  -- What the approved template carries if this one could not be delivered.
  summary      text NOT NULL DEFAULT '',
  -- Sent as the template instead; its buttons go once the owner writes.
  waiting      boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, item_id) REFERENCES inbox_items (company_id, id) ON DELETE CASCADE,
  CONSTRAINT whatsapp_sent_purpose CHECK (purpose IN ('item', 'ask', 'answer', 'text')),
  CONSTRAINT whatsapp_sent_item CHECK ((purpose = 'text') OR (company_id IS NOT NULL AND item_id IS NOT NULL)),
  CONSTRAINT whatsapp_sent_summary_size CHECK (length(summary) <= 1024)
);
CREATE INDEX whatsapp_sent_created ON whatsapp_sent (created_at);
CREATE INDEX whatsapp_sent_waiting ON whatsapp_sent (created_at) WHERE waiting;

GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_receipts, whatsapp_sent TO palugada_admin;

-- The owner's conversation, as WhatsApp reaches it.
ALTER TABLE assistant_messages DROP CONSTRAINT assistant_messages_channel;
ALTER TABLE assistant_messages
  ADD CONSTRAINT assistant_messages_channel CHECK (channel IN ('console', 'telegram', 'whatsapp'));
