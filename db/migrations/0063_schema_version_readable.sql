-- The boot refuses to run code ahead of its database (src/main.ts): a column
-- the code expects and the database lacks fails at the first query that names
-- it -- in a task, hours after an upgrade, as a SQL error. It asks as the
-- control plane, which could not read the list of applied migrations; the
-- migration role could, and a running deployment does not hold it.
GRANT SELECT ON schema_migrations TO palugada_admin;
