-- Customers write to the company (the analysis of 3 October, §9 P2 item 19).
--
-- A company could answer its owner on Telegram and WhatsApp and could not
-- answer a customer anywhere. These three tables are the conversation,
-- whatever carries it; Telegram is the first transport (a bot of the
-- company's own), and WhatsApp and a mailbox follow as further kinds.
--
-- chat_channels: a bot the owner connected, the role that answers what
-- arrives on it, the goal that work serves and what to do with each
-- message. Like a trigger (0054) it is the owner's to make and close: the
-- application role reads a channel and cannot write one. The token is
-- sealed in the deployment's store under a name of its own (`db://chat-…`),
-- which a division's credential may not name (`assertDivisionReference`),
-- and the secret Telegram sends back is kept only as its SHA-256. A closed
-- channel keeps neither: its token is deleted, and connecting the same bot
-- again opens it at a new address.
--
-- chats: one customer's conversation on one channel, by the transport's id
-- for it. The name is the one the customer gave the transport, which is
-- theirs to choose and so is data, like everything they write.
--
-- chat_messages: what was said, both ways. A message in is written by the
-- route Telegram posts to, on the control plane; a message out by
-- `chat.send`, inside the company's scope -- so the application role may add
-- only a message out, and change only the transport's id on it once sent.

CREATE TABLE chat_channels (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  -- What goes in the webhook's address. Made again when the channel is
  -- connected again, and on a restore.
  public_id     text NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', '') UNIQUE,
  -- What the customer sees: the bot's username.
  account       text NOT NULL,
  project_id    uuid NOT NULL,
  division_id   uuid NOT NULL,
  role_id       uuid NOT NULL,
  goal_id       uuid NOT NULL,
  instruction   text NOT NULL,
  -- Where the token is sealed; null once closed, and on a restored channel.
  token_ref     text,
  -- SHA-256 of the secret the transport sends with each delivery, hex.
  webhook_hash  text NOT NULL DEFAULT '',
  max_per_hour  integer NOT NULL DEFAULT 60,
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_channels_company_scoped_key UNIQUE (company_id, id),
  CONSTRAINT chat_channels_project_fkey
    FOREIGN KEY (company_id, project_id) REFERENCES projects (company_id, id) ON DELETE CASCADE,
  CONSTRAINT chat_channels_division_fkey
    FOREIGN KEY (company_id, division_id) REFERENCES divisions (company_id, id) ON DELETE CASCADE,
  CONSTRAINT chat_channels_role_fkey
    FOREIGN KEY (company_id, role_id) REFERENCES roles (company_id, id) ON DELETE CASCADE,
  CONSTRAINT chat_channels_goal_fkey
    FOREIGN KEY (company_id, goal_id) REFERENCES goals (company_id, id) ON DELETE CASCADE,
  CONSTRAINT chat_channels_kind_known CHECK (kind IN ('telegram')),
  CONSTRAINT chat_channels_account_named CHECK (length(account) BETWEEN 1 AND 64),
  CONSTRAINT chat_channels_instruction_not_blank CHECK (length(btrim(instruction)) > 0),
  CONSTRAINT chat_channels_rate_sane CHECK (max_per_hour BETWEEN 1 AND 3600),
  CONSTRAINT chat_channels_token_sealed CHECK (token_ref IS NULL OR token_ref ~ '^db://chat-[0-9a-f]{16}$'),
  -- An open channel can be reached and can answer; a closed one neither.
  CONSTRAINT chat_channels_open_has_keys CHECK (NOT enabled OR (token_ref IS NOT NULL AND webhook_hash <> ''))
);

-- A bot answers for one company at a time: connecting it to a second would
-- move its webhook there and leave the first deaf without a word.
CREATE UNIQUE INDEX chat_channels_one_open_account ON chat_channels (kind, account) WHERE enabled;
-- And one channel per bot in a company, which connecting again reopens.
CREATE UNIQUE INDEX chat_channels_account_per_company ON chat_channels (company_id, kind, account);

CREATE TABLE chats (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  channel_id       uuid NOT NULL,
  -- The transport's id for the conversation: Telegram's chat id.
  external_id      text NOT NULL,
  customer_name    text,
  customer_handle  text,
  last_message_at  timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chats_company_scoped_key UNIQUE (company_id, id),
  CONSTRAINT chats_one_per_customer UNIQUE (channel_id, external_id),
  CONSTRAINT chats_channel_fkey
    FOREIGN KEY (company_id, channel_id) REFERENCES chat_channels (company_id, id) ON DELETE CASCADE,
  CONSTRAINT chats_names_bounded CHECK (length(customer_name) <= 200 AND length(customer_handle) <= 64)
);

CREATE INDEX chats_recent ON chats (company_id, last_message_at DESC);

CREATE TABLE chat_messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  chat_id          uuid NOT NULL,
  direction        text NOT NULL,
  -- The transport's id for the message: the one it arrived with, or the one
  -- the transport gave a reply. Null for a reply not yet sent.
  external_id      text,
  body             text NOT NULL DEFAULT '',
  -- What arrived that is not text -- a photo, a voice note, a file -- by the
  -- transport's word for it; the run is told it cannot read it.
  attachment       text,
  -- In: whether it started work, joined work nobody had picked up yet, or
  -- was kept without work because the channel's hour was spent. Out: null.
  outcome          text,
  -- In: the work it started or joined; none when the hour's limit held it.
  -- Out: the work that sent it.
  task_id          uuid,
  -- Out: the broker's key for the call, so a rerun finds the reply it sent.
  idempotency_key  text,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT chat_messages_company_scoped_key UNIQUE (company_id, id),
  CONSTRAINT chat_messages_once UNIQUE (chat_id, direction, external_id),
  CONSTRAINT chat_messages_reply_once UNIQUE (chat_id, idempotency_key),
  CONSTRAINT chat_messages_chat_fkey
    FOREIGN KEY (company_id, chat_id) REFERENCES chats (company_id, id) ON DELETE CASCADE,
  CONSTRAINT chat_messages_task_fkey
    FOREIGN KEY (company_id, task_id) REFERENCES tasks (company_id, id) ON DELETE SET NULL (task_id),
  CONSTRAINT chat_messages_direction_known CHECK (direction IN ('in', 'out')),
  CONSTRAINT chat_messages_said_something CHECK (body <> '' OR attachment IS NOT NULL),
  CONSTRAINT chat_messages_body_bounded CHECK (length(body) <= 20000),
  CONSTRAINT chat_messages_attachment_known CHECK (attachment IS NULL OR attachment ~ '^[a-z_]{1,32}$'),
  CONSTRAINT chat_messages_in_has_id CHECK (direction = 'out' OR external_id IS NOT NULL),
  CONSTRAINT chat_messages_out_keyed CHECK (direction = 'in' OR idempotency_key IS NOT NULL),
  CONSTRAINT chat_messages_outcome_known CHECK (
    (direction = 'in' AND outcome IN ('started', 'joined', 'limited')) OR (direction = 'out' AND outcome IS NULL))
);

CREATE INDEX chat_messages_conversation ON chat_messages (chat_id, created_at);
-- Which chat a piece of work answers, and what a task's removal reaches.
CREATE INDEX chat_messages_task ON chat_messages (task_id) WHERE task_id IS NOT NULL;
-- The channel's hour: the messages that started work lately.
CREATE INDEX chat_messages_started ON chat_messages (chat_id, created_at) WHERE outcome = 'started';

SELECT app.enable_tenant_rls('chat_channels');
SELECT app.enable_tenant_rls('chats');
SELECT app.enable_tenant_rls('chat_messages');

-- A channel is the owner's; a conversation and what came in are written by
-- the route the transport posts to. Work in the company adds only its own
-- replies, marks when the conversation last moved, and records the id the
-- transport gave a reply.
REVOKE INSERT, UPDATE ON chat_channels FROM palugada_app;
REVOKE INSERT, UPDATE ON chats FROM palugada_app;
GRANT UPDATE (last_message_at) ON chats TO palugada_app;
REVOKE UPDATE ON chat_messages FROM palugada_app;
GRANT UPDATE (external_id) ON chat_messages TO palugada_app;
CREATE POLICY agents_write_replies ON chat_messages AS RESTRICTIVE FOR INSERT TO palugada_app
  WITH CHECK (direction = 'out');
CREATE POLICY agents_mark_replies ON chat_messages AS RESTRICTIVE FOR UPDATE TO palugada_app
  USING (direction = 'out') WITH CHECK (direction = 'out');
