-- The relay protocol, ready for a commercial relay (F19.13, F19.19, F19.20;
-- STATUS section 2.216).
--
-- Every table here is the control plane's, as section 2.208 made them: forced
-- row security, a policy that admits nothing, and no grant to the
-- application role. None is exported.

-- What a notice opens is kept beside its envelope rather than in it. The
-- envelope's link names only a handle, which the console resolves after the
-- person it was for signs in, so no company, room, thread, item or task id
-- reaches a relay. A person's notice about a room also says here which room,
-- so the relay loop asks again, as it sends, whether that person may still
-- see it.
ALTER TABLE relay_outbox
  ADD COLUMN handle    text CHECK (handle ~ '^[A-Za-z0-9_-]{32}$'),
  ADD COLUMN room_id   uuid,
  ADD COLUMN thread_of uuid,
  ADD COLUMN item_id   uuid,
  ADD COLUMN task_id   uuid;
CREATE UNIQUE INDEX relay_outbox_handle ON relay_outbox (handle) WHERE handle IS NOT NULL;

-- When an offer was spent, so it is purged four days after that rather than
-- four days after it would have expired.
ALTER TABLE relay_offers ADD COLUMN spent_at timestamptz;

-- The claim that made a link, so a relay told the link ended knows which of
-- the person's devices it was.
ALTER TABLE relay_links ADD COLUMN claim_id text CHECK (char_length(claim_id) BETWEEN 1 AND 128);

-- A company's share, at most the relay's: a map of company id to level.
CREATE FUNCTION app.share_map(shares jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN jsonb_typeof(shares) IS DISTINCT FROM 'object' THEN false
    ELSE NOT EXISTS (
      SELECT 1 FROM jsonb_each(shares) AS e(key, value)
       WHERE e.key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          OR e.value NOT IN ('"signal"'::jsonb, '"summary"'::jsonb, '"content"'::jsonb)) END $$;
-- A check runs it as whoever writes the row: the control plane.
REVOKE EXECUTE ON FUNCTION app.share_map(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.share_map(jsonb) TO palugada_admin;

ALTER TABLE relays
  -- Which process holds the pull lease: only that process releases it or
  -- moves the cursor, so a poll that outlived its lease cannot clear the
  -- next one's, nor move the cursor back.
  ADD COLUMN pulling_by     uuid,
  ADD COLUMN company_shares jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The relay's own key it rotated away from, accepted beside the new one
  -- until `previous_until`, at most a week.
  ADD COLUMN previous_key   bytea CHECK (octet_length(previous_key) = 32),
  ADD COLUMN previous_until timestamptz,
  ADD CONSTRAINT relays_company_shares CHECK (app.share_map(company_shares)),
  ADD CONSTRAINT relays_previous_whole CHECK ((previous_key IS NULL) = (previous_until IS NULL));

-- A receipt whose envelope is still being taken, found by its age without
-- reading every receipt: one left so by a process that stopped is taken over.
CREATE INDEX relay_receipts_pending ON relay_receipts (received_at) WHERE result ? 'pending';

-- A device's signature, taken once: an act signed by a person's phone is not
-- taken again under another envelope id.
CREATE TABLE relay_device_acts (
  relay_id       uuid NOT NULL REFERENCES relays(id) ON DELETE CASCADE,
  signature_hash text NOT NULL CHECK (signature_hash ~ '^[0-9a-f]{64}$'),
  at             timestamptz NOT NULL,
  PRIMARY KEY (relay_id, signature_hash)
);
CREATE INDEX relay_device_acts_at ON relay_device_acts (at);
ALTER TABLE relay_device_acts ENABLE ROW LEVEL SECURITY;
ALTER TABLE relay_device_acts FORCE ROW LEVEL SECURITY;
CREATE POLICY control_plane_only ON relay_device_acts USING (false) WITH CHECK (false);
REVOKE ALL ON relay_device_acts FROM palugada_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON relay_device_acts TO palugada_admin;
