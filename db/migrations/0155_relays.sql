-- The relay (F19.19, F19.20; STATUS section 2.208).
--
-- A relay is a service outside the deployment that tells people's phones what
-- PALUGADA has for them, and carries back the few presses a person may make
-- from a notice. Protocol v1 is notify-only (docs/relay-protocol.md): a relay
-- is told what a person who linked a phone is owed, at a share level, and is
-- never sent a room list, history or membership.
--
-- Every table here is the control plane's alone, as the owner's
-- authenticators and the staff seats are (0033, 0110): a relay belongs to the
-- deployment, not to a company, and no agent may read who is paired, who
-- linked a phone, or a token that decides something. Forced row security with
-- a policy that admits nothing, and no grant to the application role.
--
-- None of it is exported: a relay, its keys and its links are this
-- deployment's, and a restored company is paired again by its new owner.

-- The deployment's own Ed25519 key, made on first use. The private half is
-- sealed under the master key in deployment_secrets (AES-256-GCM), named by
-- its key id so a key rotated in is a new secret beside the old one; only the
-- public half is kept here. The old key keeps signing beside the new one for
-- a week after a rotation, so a relay that pinned it is not cut off.
CREATE TABLE relay_identity (
  id             boolean PRIMARY KEY DEFAULT true CHECK (id),
  public_key     bytea NOT NULL CHECK (octet_length(public_key) = 32),
  secret_ref     text NOT NULL CHECK (secret_ref ~ '^db://relay-identity-[0-9a-f]{16}$'),
  kid            text NOT NULL CHECK (kid ~ '^[0-9a-f]{16}$'),
  previous_key   bytea CHECK (octet_length(previous_key) = 32),
  previous_ref   text CHECK (previous_ref ~ '^db://relay-identity-[0-9a-f]{16}$'),
  previous_kid   text CHECK (previous_kid ~ '^[0-9a-f]{16}$'),
  previous_until timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  rotated_at     timestamptz,
  CONSTRAINT relay_identity_previous_whole CHECK (
    (previous_key IS NULL) = (previous_until IS NULL)
    AND (previous_key IS NULL) = (previous_ref IS NULL)
    AND (previous_key IS NULL) = (previous_kid IS NULL))
);

-- A relay the owner added: pending until paired, paired until revoked. Its key
-- is pinned when it is added and the owner compares its fingerprint; its
-- envelopes and inbox share its host. What it is told, and what it may send
-- back, are the owner's to widen with a fresh factor.
CREATE TABLE relays (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  url             text NOT NULL CHECK (url ~ '^https://' OR url ~ '^http://(127\.0\.0\.1|localhost)(:[0-9]+)?(/|$)'),
  envelopes_url   text NOT NULL,
  inbox_url       text,
  public_key      bytea NOT NULL CHECK (octet_length(public_key) = 32),
  fingerprint     text NOT NULL CHECK (fingerprint ~ '^[A-Z2-7]{24}$'),
  versions        integer[] NOT NULL,
  features        text[] NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paired', 'revoked')),
  mode            text NOT NULL DEFAULT 'pull' CHECK (mode IN ('push', 'pull')),
  share           text NOT NULL DEFAULT 'signal' CHECK (share IN ('signal', 'summary', 'content')),
  -- The companies named at pairing, or every company, later ones too: a
  -- choice of its own, never the default.
  companies       uuid[] NOT NULL DEFAULT '{}',
  all_companies   boolean NOT NULL DEFAULT false,
  may_press       boolean NOT NULL DEFAULT false,
  may_post        boolean NOT NULL DEFAULT false,
  -- What makes a person and a company a pseudonym the relay cannot join
  -- with another relay's.
  salt            bytea NOT NULL CHECK (octet_length(salt) = 32),
  -- The pairing request a relay's accept must name.
  pair_request_id uuid,
  inbound_cursor  text,
  -- Which process is pulling this relay's inbox, until when: replicas never
  -- poll one relay twice, and no connection is held through a long poll.
  pulling_until   timestamptz,
  failures        integer NOT NULL DEFAULT 0,
  paused_until    timestamptz,
  last_ok_at      timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  paired_at       timestamptz,
  revoked_at      timestamptz,
  CONSTRAINT relays_paired_has_a_time CHECK ((status = 'paired') = (paired_at IS NOT NULL AND revoked_at IS NULL)),
  CONSTRAINT relays_pull_has_inbox CHECK (mode = 'push' OR inbox_url IS NOT NULL),
  CONSTRAINT relays_scope_named CHECK (status <> 'paired' OR all_companies OR cardinality(companies) > 0)
);
CREATE UNIQUE INDEX relays_one_live_per_key ON relays (public_key) WHERE status <> 'revoked';

-- A person who linked a phone through a relay. No link, nothing is sent on
-- that person's behalf. A link made with a device key needs the device's
-- signature on every act, and the owner's link needs one before any act but
-- ending it counts.
CREATE TABLE relay_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  relay_id        uuid NOT NULL REFERENCES relays(id) ON DELETE CASCADE,
  principal       text NOT NULL CHECK (app.is_person(principal)),
  -- A seat's company; NULL for the owner, who is every company's.
  company_id      uuid REFERENCES companies(id) ON DELETE CASCADE,
  recipient_id    text CHECK (recipient_id ~ '^[A-Z2-7]{26}$'),
  label           text CHECK (char_length(label) <= 80),
  device_key      bytea CHECK (octet_length(device_key) = 32),
  -- The person's own ceiling, below the relay's.
  share           text CHECK (share IN ('signal', 'summary', 'content')),
  code_hash       text,
  code_expires_at timestamptz,
  status          text NOT NULL CHECK (status IN ('offered', 'active', 'ended')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  claimed_at      timestamptz,
  ended_at        timestamptz,
  CONSTRAINT relay_links_owner_has_no_company CHECK ((principal = 'owner') = (company_id IS NULL)),
  CONSTRAINT relay_links_active_is_named CHECK (status <> 'active' OR recipient_id IS NOT NULL),
  CONSTRAINT relay_links_offered_has_code CHECK (status <> 'offered' OR (code_hash IS NOT NULL AND code_expires_at IS NOT NULL))
);
CREATE UNIQUE INDEX relay_links_recipient ON relay_links (relay_id, recipient_id) WHERE status = 'active';
CREATE UNIQUE INDEX relay_links_code ON relay_links (relay_id, code_hash) WHERE status = 'offered';
CREATE INDEX relay_links_principal ON relay_links (principal) WHERE status <> 'ended';

-- What a person may do from a notice: a token the relay holds the only copy
-- of, kept here as its hash. A decision is pressed once; nothing is ever
-- offered at tier 3.
CREATE TABLE relay_offers (
  token_hash    text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  relay_id      uuid NOT NULL REFERENCES relays(id) ON DELETE CASCADE,
  link_id       uuid NOT NULL REFERENCES relay_links(id) ON DELETE CASCADE,
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  principal     text NOT NULL CHECK (app.is_person(principal)),
  act           text NOT NULL CHECK (act IN ('approve', 'deny', 'answer', 'reply', 'read', 'mute')),
  inbox_item_id uuid,
  room_id       uuid,
  thread_of     uuid,
  position      bigint,
  option        text CHECK (char_length(option) <= 80),
  max_uses      smallint NOT NULL DEFAULT 1 CHECK (max_uses BETWEEN 1 AND 20),
  uses          smallint NOT NULL DEFAULT 0,
  expires_at    timestamptz NOT NULL,
  voided_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT relay_offers_item_acts CHECK ((act IN ('approve', 'deny', 'answer')) = (inbox_item_id IS NOT NULL)),
  CONSTRAINT relay_offers_room_acts CHECK ((act IN ('reply', 'read', 'mute')) = (room_id IS NOT NULL)),
  CONSTRAINT relay_offers_decisions_once CHECK (act NOT IN ('approve', 'deny', 'answer') OR max_uses = 1),
  CONSTRAINT relay_offers_within CHECK (uses <= max_uses)
);
CREATE INDEX relay_offers_live ON relay_offers (company_id, principal) WHERE voided_at IS NULL AND uses < max_uses;
CREATE INDEX relay_offers_item ON relay_offers (inbox_item_id) WHERE inbox_item_id IS NOT NULL;
CREATE INDEX relay_offers_link ON relay_offers (link_id);

-- What is owed to a relay, one envelope a row, sent by the relay loop and not
-- by whoever enqueued it. The id is the envelope's and the webhook id, made
-- from what the envelope is about, so a resend after a crash is the same
-- envelope and the relay drops it as a duplicate.
CREATE TABLE relay_outbox (
  id           uuid PRIMARY KEY,
  relay_id     uuid NOT NULL REFERENCES relays(id) ON DELETE CASCADE,
  link_id      uuid REFERENCES relay_links(id) ON DELETE CASCADE,
  company_id   uuid REFERENCES companies(id) ON DELETE CASCADE,
  type         text NOT NULL CHECK (type ~ '^[a-z_]{2,32}$'),
  -- 'item:<id>', 'task:<id>', 'message:<id>': what a retraction looks for.
  subjects     text[] NOT NULL DEFAULT '{}',
  -- Canonical JSON, as it is signed at send time.
  body         text NOT NULL CHECK (octet_length(body) <= 65536),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'delivered', 'dead')),
  attempts     smallint NOT NULL DEFAULT 0,
  next_at      timestamptz NOT NULL DEFAULT now(),
  claimed_at   timestamptz,
  delivered_at timestamptz,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX relay_outbox_due ON relay_outbox (relay_id, next_at) WHERE status = 'pending';
CREATE INDEX relay_outbox_sending ON relay_outbox (claimed_at) WHERE status = 'sending';
CREATE INDEX relay_outbox_subjects ON relay_outbox USING gin (subjects);

-- Inbound envelope ids, kept fourteen days: an envelope is taken once, and a
-- repeat is answered as the first was.
CREATE TABLE relay_receipts (
  relay_id    uuid NOT NULL REFERENCES relays(id) ON DELETE CASCADE,
  envelope_id text NOT NULL CHECK (char_length(envelope_id) BETWEEN 1 AND 128),
  received_at timestamptz NOT NULL DEFAULT now(),
  result      jsonb NOT NULL,
  PRIMARY KEY (relay_id, envelope_id)
);

-- Signed inbound refusals that name no company, kept fourteen days. One that
-- names a company is in that company's record instead; an unsigned one is
-- only counted, so the open route cannot be made to fill a table.
CREATE TABLE relay_refusals (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  relay_id uuid NOT NULL REFERENCES relays(id) ON DELETE CASCADE,
  reason   text NOT NULL,
  detail   jsonb,
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX relay_refusals_at ON relay_refusals (at);

ALTER TABLE relay_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE relay_identity FORCE ROW LEVEL SECURITY;
CREATE POLICY control_plane_only ON relay_identity USING (false) WITH CHECK (false);
REVOKE ALL ON relay_identity FROM palugada_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON relay_identity TO palugada_admin;

ALTER TABLE relays ENABLE ROW LEVEL SECURITY;
ALTER TABLE relays FORCE ROW LEVEL SECURITY;
CREATE POLICY control_plane_only ON relays USING (false) WITH CHECK (false);
REVOKE ALL ON relays FROM palugada_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON relays TO palugada_admin;

ALTER TABLE relay_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE relay_links FORCE ROW LEVEL SECURITY;
CREATE POLICY control_plane_only ON relay_links USING (false) WITH CHECK (false);
REVOKE ALL ON relay_links FROM palugada_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON relay_links TO palugada_admin;

ALTER TABLE relay_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE relay_offers FORCE ROW LEVEL SECURITY;
CREATE POLICY control_plane_only ON relay_offers USING (false) WITH CHECK (false);
REVOKE ALL ON relay_offers FROM palugada_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON relay_offers TO palugada_admin;

ALTER TABLE relay_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE relay_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY control_plane_only ON relay_outbox USING (false) WITH CHECK (false);
REVOKE ALL ON relay_outbox FROM palugada_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON relay_outbox TO palugada_admin;

ALTER TABLE relay_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE relay_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY control_plane_only ON relay_receipts USING (false) WITH CHECK (false);
REVOKE ALL ON relay_receipts FROM palugada_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON relay_receipts TO palugada_admin;

ALTER TABLE relay_refusals ENABLE ROW LEVEL SECURITY;
ALTER TABLE relay_refusals FORCE ROW LEVEL SECURITY;
CREATE POLICY control_plane_only ON relay_refusals USING (false) WITH CHECK (false);
REVOKE ALL ON relay_refusals FROM palugada_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON relay_refusals TO palugada_admin;
