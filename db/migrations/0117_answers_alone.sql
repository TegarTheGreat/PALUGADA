-- A customer's question answered without the owner, when the answer is the
-- company's own published words (STATUS 2.137).
--
-- Every reply to a customer waited for the owner (0111): the work began with
-- a stranger's words (F8.9). The owner may now let a channel answer on its
-- own, from the documents they mark as theirs to tell customers, and the
-- broker lets such a reply go without a card when the capability's own check
-- finds it grounded in those passages (src/capabilities/chat.ts).

-- The owner's switch, per channel: off unless they turn it on, with their
-- device. Written on the control plane, as the rest of a channel is.
ALTER TABLE chat_channels
  ADD COLUMN answers_alone boolean NOT NULL DEFAULT false;

-- Which documents customers may be told. A price list is; the margins and
-- the supplier's contract are not, and are never quoted to a customer on
-- their own. The owner's documents, so the owner's mark.
ALTER TABLE documents
  ADD COLUMN for_customers boolean NOT NULL DEFAULT false;

-- What a reply that went on its own was answered from: the documents and
-- passages, kept with the message so the owner reading the conversation sees
-- which of their words it said. Null for a reply the owner approved.
ALTER TABLE chat_messages
  ADD COLUMN grounds jsonb;

-- The mark is the owner's, so the application role may not set it: a run
-- that could would widen what goes out without the owner. It keeps the one
-- column it changes for the owner, a document's archiving.
REVOKE UPDATE ON documents FROM palugada_app;
GRANT UPDATE (archived_at) ON documents TO palugada_app;
