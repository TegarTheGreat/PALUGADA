-- The owner's yes for a while, rather than for one action.
--
-- A policy that asks the owner before a role sends an email asks every time,
-- and an owner with several companies answers the same card forty times a
-- day or stops reading them -- which is how a single owner loses control of
-- an approval queue. Copilot Studio's "approve for this session" and OpenAI
-- Dots's per-action rules answer the same complaint. Here the owner, deciding
-- one such card, may say yes to the same capability for the same role for a
-- while: at most a week, with their second factor, revocable at any time.
--
-- Narrow on purpose:
-- - only an approval a policy asked for, at tier 2 or below. Tier 3 is one
--   action at a time with a second factor (F10.10), and an action asked about
--   because the work read content from outside (F8.9) is never taken on the
--   strength of that content alone, however recently something like it was
--   approved.
-- - one role and one capability, whatever the arguments: not a division, not
--   a family of capabilities.
--
-- Written by the owner's console on the control plane; the application role
-- reads a grant and counts its uses, and can neither make one nor extend one.
CREATE TABLE standing_approvals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role_id          uuid NOT NULL,
  capability_name  text NOT NULL,
  -- The card the owner was deciding when they gave it.
  granted_by_item  uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  uses             integer NOT NULL DEFAULT 0,
  last_used_at     timestamptz,
  FOREIGN KEY (company_id, role_id) REFERENCES roles (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, granted_by_item) REFERENCES inbox_items (company_id, id) ON DELETE CASCADE,
  UNIQUE (company_id, id),
  CONSTRAINT standing_approvals_at_most_a_week
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '7 days'),
  CONSTRAINT standing_approvals_uses_non_negative CHECK (uses >= 0)
);

SELECT app.enable_tenant_rls('standing_approvals');

-- enable_tenant_rls grants the application role everything; it is given back
-- what an agent's work needs, which is to find a grant and count a use.
REVOKE INSERT, DELETE, UPDATE ON standing_approvals FROM palugada_app;
GRANT UPDATE (uses, last_used_at) ON standing_approvals TO palugada_app;

CREATE INDEX standing_approvals_live
  ON standing_approvals (company_id, role_id, capability_name, expires_at)
  WHERE revoked_at IS NULL;
