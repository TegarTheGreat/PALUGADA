-- A topic for each company in the owner's chat with the bot.
--
-- Telegram lets a bot have topics in a private chat (Bot API 9.3), once its
-- owner turns topic mode on in @BotFather. With it, what a company raises
-- arrives in that company's topic, and what the owner writes there is said to
-- that company's CEO: an owner of five companies reads five threads, not one
-- stream, and does not have to say whom they are talking to. PALUGADA's own
-- assistant, which answers for the whole deployment, has a topic too.
--
-- Telegram gives a bot no way to list the topics it made, so the thread each
-- one got is kept here; without it a restart would make every topic again.
-- Like the owner's conversation (0066) it belongs to the owner and no company:
-- no row security, and no grant to the application role.

CREATE TABLE telegram_topics (
  -- The owner's chat with the bot, whose id is the owner's user id.
  chat_id     text NOT NULL,
  -- The company whose topic it is; null for PALUGADA's own.
  company_id  uuid REFERENCES companies (id) ON DELETE CASCADE,
  thread_id   bigint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- One topic per company per chat, PALUGADA's included, and one owner per topic.
CREATE UNIQUE INDEX telegram_topics_company ON telegram_topics (chat_id, (coalesce(company_id::text, 'palugada')));
CREATE UNIQUE INDEX telegram_topics_thread ON telegram_topics (chat_id, thread_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON telegram_topics TO palugada_admin;
