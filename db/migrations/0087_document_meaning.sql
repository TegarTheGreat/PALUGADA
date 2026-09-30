-- The meaning of each passage of the company's documents, as a vector (F4.2).
--
-- A search matched words only, and pgvector sat installed and unused: a role
-- asking about the refund policy found nothing in "Returns and money back".
-- With a provider chosen under Tools, the worker gives each passage a vector
-- and a search ranks by words and meaning together.
--
-- No fixed dimension: it is the provider's, and the owner can change the
-- provider. Each vector is kept with the model that made it, and a search
-- compares only vectors of the model in use -- two models' vectors are not
-- comparable, and a search across them is confident nonsense rather than an
-- error. No index: the scope filter runs before the similarity, as for
-- memories (0005), and a company's documents are passages in the thousands.

ALTER TABLE document_passages
  ADD COLUMN embedding vector,
  ADD COLUMN embedding_model text,
  ADD CONSTRAINT document_passages_embedding_has_model CHECK ((embedding IS NULL) = (embedding_model IS NULL));

-- The worker writes them through the company's own connection. Passages are
-- otherwise never changed by the application role (0075); this is the one
-- thing about one that is.
GRANT UPDATE (embedding, embedding_model) ON document_passages TO palugada_app;
