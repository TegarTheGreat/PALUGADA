-- A division's room shows all of its work from when it was told to (F19.16;
-- STATUS section 2.206).
--
-- A room told to show all of its division's work gets a card for every
-- piece of root work the division is given from then on, and none for what
-- came before. When that was is kept on the room itself. The room's feed is
-- no place for it: the feed is bookkeeping, purged after two weeks, and it
-- also moves when only the room's name or what it is about changes, which
-- changes nothing of the work it shows.
--
-- Kept by the database, never by a statement: set when a room is made, and
-- again whenever what it shows changes. The application role may not write
-- the column (0150 grants it only the columns a person changes), and a
-- value given on insert is replaced. An archive read in on the control plane
-- keeps its own, as it keeps a room's other dates.

-- Rooms that exist already are taken as shown since now: a room switched
-- before this migration has had its cards posted by the sweep it ran then.
ALTER TABLE rooms ADD COLUMN shows_work_since timestamptz NOT NULL DEFAULT now();

CREATE FUNCTION app.rooms_shows_work_since() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app.reader() = 'control' THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    -- rooms_guard, which fires first by name, has made it now.
    NEW.shows_work_since := NEW.created_at;
  ELSIF NEW.shows_work IS DISTINCT FROM OLD.shows_work THEN
    NEW.shows_work_since := clock_timestamp();
  ELSE
    NEW.shows_work_since := OLD.shows_work_since;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rooms_shows_work_since BEFORE INSERT OR UPDATE ON rooms
  FOR EACH ROW EXECUTE FUNCTION app.rooms_shows_work_since();
