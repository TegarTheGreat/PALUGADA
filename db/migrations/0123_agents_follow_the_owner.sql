-- The agents' default language follows the owner's, until the owner says
-- otherwise.
--
-- `agent_language` was born NOT NULL DEFAULT 'en' (0052): every deployment had
-- an answer, and the answer was English. So an owner who chose Indonesian for
-- the panel -- the only language the console asks about first -- had a console
-- in Indonesian and a team that wrote, greeted and reported in English, in
-- every company that had not been given a language of its own.
--
-- NULL now means "the panel's language, and English where the panel has none".
-- A language the owner picks under Settings, Languages is kept as it is.
--
-- The rows that exist: 'en' is what every deployment was born with, so an
-- 'en' that nobody chose cannot be told from one somebody did. It is cleared,
-- because the owner who never touched it is the common case and the one that
-- was being wronged; the rare owner who chose English for their team on
-- purpose, while reading the panel in another language, chooses it again, one
-- select under Settings, Languages.
ALTER TABLE platform_control
  ALTER COLUMN agent_language DROP NOT NULL,
  ALTER COLUMN agent_language DROP DEFAULT;

UPDATE platform_control SET agent_language = NULL WHERE agent_language = 'en';
