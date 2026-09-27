-- The owner's conversation with the assistant (src/owner/assistant.ts).
--
-- The assistant reads what the console can read and proposes what the
-- console can do; a proposal changes nothing until the owner applies it, with
-- their device where the route takes one. The conversation is kept here
-- rather than in the browser -- the console stores nothing there -- and so
-- that it survives the restart a saved setting causes, and is the same
-- conversation from the console and from Telegram.
--
-- Like deployment_settings, both belong to the one owner and no company: no
-- row security, and no grant to the application role, whose agents must not
-- read what the owner said or propose on their behalf.

CREATE TABLE assistant_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The owner, the assistant, or what happened to a proposal.
  role        text NOT NULL,
  channel     text NOT NULL DEFAULT 'console',
  body        text NOT NULL,
  -- clock_timestamp, not now(): two messages written in one transaction are
  -- still in the order they were written.
  at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT assistant_messages_role CHECK (role IN ('owner', 'assistant', 'event')),
  CONSTRAINT assistant_messages_channel CHECK (channel IN ('console', 'telegram')),
  CONSTRAINT assistant_messages_body_size CHECK (length(body) <= 20000)
);
CREATE INDEX assistant_messages_at ON assistant_messages (at);

CREATE TABLE assistant_proposals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  uuid NOT NULL REFERENCES assistant_messages (id) ON DELETE CASCADE,
  summary     text NOT NULL,
  -- A route of the owner API and the body it is sent, without the owner's
  -- proof and without any secret: those arrive when the owner applies it.
  path        text NOT NULL,
  body        jsonb NOT NULL DEFAULT '{}',
  -- The fields the owner types into a sealed field on the card: name -> label.
  secrets     jsonb NOT NULL DEFAULT '{}',
  factor      text NOT NULL,
  status      text NOT NULL DEFAULT 'open',
  outcome     text,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at  timestamptz,
  CONSTRAINT assistant_proposals_path CHECK (path ~ '^/api/'),
  CONSTRAINT assistant_proposals_body_object CHECK (jsonb_typeof(body) = 'object'),
  CONSTRAINT assistant_proposals_secrets_object CHECK (jsonb_typeof(secrets) = 'object'),
  CONSTRAINT assistant_proposals_factor CHECK (factor IN ('always', 'sometimes', 'never')),
  CONSTRAINT assistant_proposals_status CHECK (status IN ('open', 'applied', 'dismissed', 'failed')),
  CONSTRAINT assistant_proposals_decided CHECK ((status = 'open') = (decided_at IS NULL))
);
CREATE INDEX assistant_proposals_message ON assistant_proposals (message_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON assistant_messages, assistant_proposals TO palugada_admin;
