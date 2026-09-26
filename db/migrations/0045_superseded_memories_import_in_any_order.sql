-- ---------------------------------------------------------------------------
-- A superseded memory can be written before the memory that replaced it
--
-- `supersede` points the older memory's `superseded_by` at the newer one, and
-- an archive lists memories oldest first -- so an import writes the older row
-- while the row it points at does not exist yet, and an immediate foreign key
-- refuses it. Every company that had ever corrected a fact failed to restore.
--
-- Checked at commit instead. The import is one transaction, and by its end
-- every row it references is there; a reference that is still dangling then
-- is refused exactly as before.
-- ---------------------------------------------------------------------------

ALTER TABLE memories
  ALTER CONSTRAINT memories_superseded_by_fkey DEFERRABLE INITIALLY DEFERRED;
