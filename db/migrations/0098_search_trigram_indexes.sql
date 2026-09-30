-- The owner's search across every company (src/owner/search.ts) looks for a
-- phrase anywhere in a task's goal and result, in a decision's title, summary
-- and note, and in a fact: `ILIKE '%...%'`, which no btree can serve, so
-- every search read every row of all three tables, for every company at
-- once. A trigram index serves a pattern with a wildcard at either end, and
-- one is made here for exactly the columns the search reads, each spelled as
-- the search spells it so the planner can match them.
--
-- pg_trgm is a trusted extension (PostgreSQL 13 and later): the database's
-- owner, which runs the migrations, may install it. Provisioning installs it
-- as the superuser beside pgcrypto and vector (scripts/provision-database.ts,
-- scripts/setup-database.sh); this installs it where a database was
-- provisioned before it was on that list, and names the remedy where the
-- server does not have it at all.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    BEGIN
      CREATE EXTENSION pg_trgm;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'pg_trgm is not installed in this database, and % could not install it: %', current_user, SQLERRM
        USING HINT = 'pg_trgm is one of PostgreSQL''s contrib modules, in the postgres and pgvector/pgvector images. '
          || 'Install it as a superuser (CREATE EXTENSION pg_trgm in this database, or node scripts/provision-database.ts), '
          || 'then run the migrations again';
    END;
  END IF;
END $$;

-- A plain CREATE INDEX, not CONCURRENTLY. Every migration runs in one
-- transaction with the row that records it (scripts/migrate.ts), and
-- CONCURRENTLY cannot run in a transaction. A plain build holds writes to the
-- table it indexes while it runs: for the rows one owner's companies make, a
-- matter of seconds, taken once, in the upgrade's migrate step before the new
-- code starts. A replica still running the old code waits those seconds to
-- write; nothing is lost.
CREATE INDEX tasks_goal_trgm_idx ON tasks USING gin ((input->>'goal') gin_trgm_ops);
CREATE INDEX tasks_summary_trgm_idx ON tasks USING gin ((output->>'summary') gin_trgm_ops);
CREATE INDEX inbox_items_title_trgm_idx ON inbox_items USING gin (title gin_trgm_ops);
CREATE INDEX inbox_items_action_summary_trgm_idx ON inbox_items USING gin (action_summary gin_trgm_ops);
CREATE INDEX inbox_items_owner_note_trgm_idx ON inbox_items USING gin (owner_note gin_trgm_ops);
CREATE INDEX memories_body_trgm_idx ON memories USING gin (body gin_trgm_ops);
