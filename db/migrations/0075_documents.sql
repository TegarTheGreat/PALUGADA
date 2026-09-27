-- The company's documents: what it knows that is longer than a fact.
--
-- A price list, a supplier contract, the brand guide, the returns policy as
-- the lawyer wrote it. Memory holds facts of a sentence or two (0071 caps
-- one at 4,000 characters), so a document had nowhere to go: the owner
-- could paste it into a fact and have it cut short, or not at all. A
-- document is kept whole here and in passages, and `memory.search` finds
-- the passages -- every role that can search what the company knows can
-- search its documents too, without a thirteenth tool (F2.4).
--
-- Searched by its words, with PostgreSQL's own text search: it needs no
-- embedding model, and a deployment with none still has a knowledge base.

CREATE TABLE documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- Where it applies: one division's, or the whole company's when null.
  division_id   uuid,
  title         text NOT NULL,
  body          text NOT NULL,
  -- The file it came from, when it came from one: for the owner's record.
  file_name     text,
  source        text NOT NULL DEFAULT 'owner',
  created_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  CONSTRAINT documents_company_scoped_key UNIQUE (company_id, id),
  CONSTRAINT documents_division_fkey FOREIGN KEY (company_id, division_id) REFERENCES divisions (company_id, id) ON DELETE CASCADE,
  CONSTRAINT documents_title_shape CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT documents_body_size CHECK (length(body) BETWEEN 1 AND 1000000),
  CONSTRAINT documents_source_known CHECK (source IN ('owner'))
);
CREATE INDEX documents_by_company ON documents (company_id, created_at DESC);
SELECT app.enable_tenant_rls('documents');
-- Archived, never removed: a run may have acted on what it said.
REVOKE DELETE ON documents FROM palugada_app;

-- A document in passages of a few paragraphs, each searchable by its words
-- and by the heading it sits under.
CREATE TABLE document_passages (
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  document_id   uuid NOT NULL,
  seq           integer NOT NULL,
  heading       text,
  body          text NOT NULL,
  words         tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(heading, '') || ' ' || body)) STORED,
  PRIMARY KEY (document_id, seq),
  CONSTRAINT document_passages_document_fkey FOREIGN KEY (company_id, document_id) REFERENCES documents (company_id, id) ON DELETE CASCADE,
  CONSTRAINT document_passages_seq_positive CHECK (seq >= 1),
  CONSTRAINT document_passages_body_size CHECK (length(body) BETWEEN 1 AND 4000)
);
CREATE INDEX document_passages_words ON document_passages USING gin (words);
SELECT app.enable_tenant_rls('document_passages');
REVOKE UPDATE, DELETE ON document_passages FROM palugada_app;
