-- A company's mailbox as a customer channel: the third transport of the
-- conversations 0111 began, and the one every small business already has.
--
-- A mailbox is read, not posted to: a worker opens it over IMAP every minute
-- or so and reads what arrived since the last message it read. So it needs
-- what neither chat transport did:
--
--   - mail: where the mailbox is -- the IMAP and SMTP hosts and ports, and
--     the name it signs in with. Not secret, and kept when the channel is
--     closed so it can be connected again; the password is token_ref, sealed
--     as a bot's token is.
--   - poll_state: the inbox's UIDVALIDITY and the last UID read. A mailbox
--     is read from the moment it was connected, never from its history, and
--     read again from the start of now when the server renumbers it.
--   - polled_at, poll_failure: when a worker last took it (so two workers do
--     not read it at once, and nobody reads it every second), and why the
--     last reading failed, for the owner.
--
-- A message's subject is kept with it: a reply is sent as one, in the thread.

ALTER TABLE chat_channels
  ADD COLUMN mail jsonb,
  ADD COLUMN poll_state jsonb,
  ADD COLUMN polled_at timestamptz,
  ADD COLUMN poll_failure text;

ALTER TABLE chat_channels
  DROP CONSTRAINT chat_channels_kind_known,
  ADD CONSTRAINT chat_channels_kind_known CHECK (kind IN ('telegram', 'whatsapp', 'email')),
  -- An address is up to 254 characters; a bot's name and a number are shorter.
  DROP CONSTRAINT chat_channels_account_named,
  ADD CONSTRAINT chat_channels_account_named CHECK (length(account) BETWEEN 1 AND 254),
  ADD CONSTRAINT chat_channels_mail_is_email CHECK (mail IS NULL OR kind = 'email'),
  ADD CONSTRAINT chat_channels_failure_bounded CHECK (length(poll_failure) <= 1000),
  DROP CONSTRAINT chat_channels_open_has_keys,
  ADD CONSTRAINT chat_channels_open_has_keys CHECK (NOT enabled OR (token_ref IS NOT NULL AND CASE kind
    WHEN 'email' THEN mail IS NOT NULL
    WHEN 'whatsapp' THEN webhook_hash <> '' AND secret_ref IS NOT NULL AND account_id IS NOT NULL
    ELSE webhook_hash <> '' END));

-- The mailboxes due a reading, oldest reading first.
CREATE INDEX chat_channels_mail_due ON chat_channels (polled_at NULLS FIRST) WHERE kind = 'email' AND enabled;

-- A customer's address is their handle, and is longer than a username.
ALTER TABLE chats
  DROP CONSTRAINT chats_names_bounded,
  ADD CONSTRAINT chats_names_bounded CHECK (length(customer_name) <= 200 AND length(customer_handle) <= 254);

ALTER TABLE chat_messages
  ADD COLUMN subject text,
  ADD CONSTRAINT chat_messages_subject_bounded CHECK (length(subject) <= 998);
