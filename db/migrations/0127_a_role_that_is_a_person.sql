-- A person is an actor (the audit of 6 October, §8.2, P1.1, step d).
--
-- A role can be a person: a contractor the company employs through a staff
-- seat (0110). The work given to the role is put to that person as a question,
-- and their answer is what the role produced. The seat is not a foreign key
-- for the reason `inbox_items.addressee_seat` is not (0126): seats are the
-- control plane's alone, and the record must outlive them. The name is kept
-- beside it, so a task that was given to a person still says whom after the
-- seat is gone.
--
-- A role of runtime `person` always has a name, and has a seat while one is
-- seated. A company restored from an archive has the names and no seats (seats
-- are one deployment's), so its person roles come back unbound: they refuse
-- their work, saying whom to seat, rather than being given to a model.
ALTER TABLE roles
  ADD COLUMN person_seat uuid,
  ADD COLUMN person_name text,
  ADD CONSTRAINT roles_person_is_named CHECK (
    (runtime = 'person') = (person_name IS NOT NULL) AND (person_seat IS NULL OR runtime = 'person')
  ),
  ADD CONSTRAINT roles_person_name_bounded CHECK (person_name IS NULL OR length(person_name) BETWEEN 1 AND 120);

COMMENT ON COLUMN roles.person_seat IS
  'The staff seat a role of runtime person is: its tasks are put to that person as questions (P1.1d). Null when unbound.';
