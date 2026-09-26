-- Languages: what the owner's panel is drawn in, what agents write in by
-- default, and -- per company -- the language of its work and of its talk.
--
-- The panel's language belongs to the one owner (NG3), so it lives on
-- platform_control with the owner's hours. NULL there means "follow the
-- browser", which is what a deployment nobody has configured should do.
--
-- A company's two languages are NULL until it chooses, and then the
-- deployment's `agent_language` applies. Two, not one, because what a company
-- produces for its customers and what its agents say to its owner are
-- different questions with different answers -- a shop in Bandung writes its
-- product copy in Indonesian whatever language its owner reads.
--
-- The check is on the shape of a language tag rather than a list: the list of
-- languages offered lives in src/domain/language.ts and grows without a
-- migration; the database only refuses what could never be a tag.

ALTER TABLE platform_control
  ADD COLUMN console_language text,
  ADD COLUMN agent_language text NOT NULL DEFAULT 'en',
  ADD CONSTRAINT platform_console_language_tag
    CHECK (console_language IS NULL OR console_language ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  ADD CONSTRAINT platform_agent_language_tag
    CHECK (agent_language ~ '^[a-z]{2,3}(-[A-Z]{2})?$');

ALTER TABLE companies
  ADD COLUMN work_language text,
  ADD COLUMN talk_language text,
  ADD CONSTRAINT companies_work_language_tag
    CHECK (work_language IS NULL OR work_language ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  ADD CONSTRAINT companies_talk_language_tag
    CHECK (talk_language IS NULL OR talk_language ~ '^[a-z]{2,3}(-[A-Z]{2})?$');
