-- ---------------------------------------------------------------------------
-- Bundles (PRD v2 F16.1, F16.2, F16.5, F12.10)
--
-- A bundle is a versioned package: roles, skills, hooks, capability grants,
-- policies and a heartbeat schedule, shipped together because they are only
-- coherent together. A role without its grants cannot act; a grant without its
-- policy is a hole; a skill without the role it was written for is advice
-- nobody asked for.
--
-- Bundles are platform-level rather than tenant-level: the same `content-ops`
-- is installed into many companies, and a per-company copy would mean a fix
-- has to be applied once per tenant. What *is* tenant-level is the
-- installation -- which company has which version, and the hash it had when it
-- went in.
--
-- The hash is the point of F16.2. A signature says who published it; the hash
-- says whether what is installed is still what they published. Recording it at
-- install time is what makes the second question answerable later, which is
-- the question that actually gets asked after something goes wrong.
-- ---------------------------------------------------------------------------

CREATE TABLE bundles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL,
  version       text NOT NULL,
  name          text NOT NULL,
  description   text NOT NULL DEFAULT '',
  -- The package itself, in the shape src/bundles/bundle.ts exports.
  body          jsonb NOT NULL,
  -- sha256 of the canonical serialisation of `body`. Computed on insert by the
  -- caller and re-derivable at any time, which is what makes tampering with
  -- the row visible rather than merely discouraged.
  content_hash  text NOT NULL,
  -- F16.2, F12.10. A bundle with no signature is installable only in
  -- quarantine, where it may hold tier 0 grants and nothing else.
  signature     text,
  signed_by     text,
  publisher_key text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (slug, version)
);
-- No grant to palugada_app. A bundle is platform configuration -- what roles
-- exist, what they may reach, what the hooks refuse -- and an agent that could
-- read the catalogue could read the shape of every other company's
-- installation. It carries no tenant data, so it needs no RLS; it is kept out
-- of the application role's reach instead, which is the stronger of the two.
GRANT SELECT, INSERT, UPDATE, DELETE ON bundles TO palugada_admin;

CREATE TABLE bundle_installs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bundle_id     uuid NOT NULL REFERENCES bundles(id) ON DELETE RESTRICT,
  slug          text NOT NULL,
  version       text NOT NULL,
  -- Recorded at install, never updated. If the bundle row is ever edited, this
  -- is how the difference is noticed.
  installed_hash text NOT NULL,
  -- F12.10: an unsigned bundle installs quarantined, which means tier 0 only.
  quarantined   boolean NOT NULL DEFAULT false,
  installed_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, slug)
);
SELECT app.enable_tenant_rls('bundle_installs');
