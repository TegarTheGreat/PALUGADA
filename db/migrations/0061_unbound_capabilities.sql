-- A catalogued capability that no vendor is bound to yet.
--
-- The standard template grants twenty capabilities that need somebody's
-- account (email.send, invoice.pay, ...), and every grant is a foreign key
-- into `capabilities`. The registry wrote a row only when an adapter was bound,
-- so on a deployment with no vendor file the grants had nothing to point at
-- and the owner could not start a company at all.
--
-- The boot now records each catalogued capability by name, with the tier the
-- catalogue calibrated and `adapter = 'unbound'`. Such a row has no read-back
-- because it has no adapter -- which is what `capabilities_write_requires_verify`
-- refused -- and it cannot be called: the broker refuses it, naming the vendor
-- file, until an adapter is registered and the registry's sync replaces the
-- row with the bound one, read-back and all.
ALTER TABLE capabilities DROP CONSTRAINT capabilities_write_requires_verify;
ALTER TABLE capabilities ADD CONSTRAINT capabilities_write_requires_verify
  CHECK (default_tier = 0 OR has_verify OR adapter = 'unbound');
