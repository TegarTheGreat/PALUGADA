-- When the owner finished, or skipped, the console's tour of itself.
--
-- On platform_control, beside the panel's language (0052), because it
-- belongs to the one owner and not to a device: the console stores nothing
-- in the browser, and a tour that came back on every new phone would be one
-- the owner learns to dismiss without reading. NULL means not yet, which is
-- where every deployment starts.
ALTER TABLE platform_control ADD COLUMN tour_finished_at timestamptz;
