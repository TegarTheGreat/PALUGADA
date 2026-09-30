-- A trigger whose token travels in the address (src/scheduler/triggers.ts).
--
-- Some senders can set nothing but a URL: Coolify's outgoing webhook, and
-- many form builders and chat relays. 'url' is a trigger like 'bearer' -- the
-- platform makes its token and keeps only the hash -- whose delivery carries
-- the token as `?token=` rather than in an Authorization header. Anyone who
-- sees the address can start the work, and the owner is told so where the
-- scheme is chosen; a bearer trigger refuses a token in the address.

ALTER TABLE triggers DROP CONSTRAINT triggers_scheme_known;
ALTER TABLE triggers
  ADD CONSTRAINT triggers_scheme_known
    CHECK (scheme IN ('bearer', 'url', 'github', 'stripe', 'slack', 'standard'));
ALTER TABLE triggers DROP CONSTRAINT triggers_secret_matches_scheme;
ALTER TABLE triggers
  ADD CONSTRAINT triggers_secret_matches_scheme
    CHECK ((scheme IN ('bearer', 'url')) = (secret_ref IS NULL));
