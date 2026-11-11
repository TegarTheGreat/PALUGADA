-- A notice opens at the message it tells of (F19.13, F19.16; STATUS
-- sections 2.216 and 2.218).
--
-- A search hit, a pin and an Activity entry open their room around the
-- message, marked, by the message's place in the room's order. A notice
-- sent through a relay names only a handle, and what it opens -- the room,
-- the thread, the item or the task -- is kept here beside its envelope and
-- never in it; its message's place is kept with them, so the handle opens
-- the room where the notice's words were said. The place is a number in the
-- room's own order, never an id, and like the rest of the row it is never
-- sent to a relay.
--
-- The table stays the control plane's, as section 2.208 made it: forced row
-- security, a policy that admits nothing, no grant to the application role,
-- and not exported.
ALTER TABLE relay_outbox
  ADD COLUMN position bigint CHECK (position IS NULL OR (position > 0 AND room_id IS NOT NULL));
