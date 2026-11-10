-- The owner's yes for what a schedule does, every time it does exactly that
-- (STATUS 2.135; the tools research, §5 idea 3, from OpenClaw's standing
-- grants for automations).
--
-- A schedule that reads the suppliers' mailbox each morning and sends the
-- same confirmation to the same supplier asks the owner every morning: its
-- work read content from outside (F8.9), and the yes for a while (0083) never
-- reaches such work, because what was read could have shaped the action. An
-- action every byte of which the owner already approved, for this schedule
-- as it is defined, was not shaped by anything: whatever the mail said, it is
-- the action they said yes to. So the owner, deciding such a card, may say
-- yes to it every time this schedule does exactly this.
--
-- Narrow on purpose:
-- - one schedule, as it is defined when the yes is given: a digest of its
--   role, division, project, goal, account, instruction and timing, so an
--   edited schedule is asked about again;
-- - one capability and one action, to the byte (`action_fingerprint`, the
--   digest of its whole input, as on the card);
-- - tier 2 or below: a tier 3 action is one at a time with a second factor
--   (F10.10);
-- - ninety days at most, with the owner's device, revocable at any time.
--
-- Written by the owner's console on the control plane; the application role
-- reads a yes and counts its uses, and can neither make one nor extend one.
CREATE TABLE schedule_approvals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  schedule_id         uuid NOT NULL,
  -- The digest of the schedule's definition the yes was given for.
  schedule_definition text NOT NULL,
  capability_name     text NOT NULL,
  action_fingerprint  text NOT NULL,
  -- The card the owner was deciding when they gave it.
  granted_by_item     uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  revoked_at          timestamptz,
  uses                integer NOT NULL DEFAULT 0,
  last_used_at        timestamptz,
  FOREIGN KEY (company_id, schedule_id) REFERENCES schedules (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, granted_by_item) REFERENCES inbox_items (company_id, id) ON DELETE CASCADE,
  UNIQUE (company_id, id),
  CONSTRAINT schedule_approvals_at_most_ninety_days
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '90 days'),
  CONSTRAINT schedule_approvals_uses_non_negative CHECK (uses >= 0)
);

SELECT app.enable_tenant_rls('schedule_approvals');

-- enable_tenant_rls grants the application role everything; it is given back
-- what an agent's work needs, which is to find a yes and count a use.
REVOKE INSERT, DELETE, UPDATE ON schedule_approvals FROM palugada_app;
GRANT UPDATE (uses, last_used_at) ON schedule_approvals TO palugada_app;

CREATE INDEX schedule_approvals_live
  ON schedule_approvals (company_id, schedule_id, capability_name, action_fingerprint)
  WHERE revoked_at IS NULL;

-- Which schedule a task's work belongs to: the one its root names. Only the
-- task a schedule made carries `schedule_id` (0049); what it handed on is
-- the same work, found by walking up. Bounded, though the hop limit already
-- is (F6.4). Row security applies as it does to the caller.
CREATE FUNCTION app.task_schedule(task uuid) RETURNS uuid
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE up (id, parent_task_id, schedule_id, depth) AS (
    SELECT id, parent_task_id, schedule_id, 0 FROM tasks WHERE id = task
    UNION ALL
    SELECT t.id, t.parent_task_id, t.schedule_id, up.depth + 1
      FROM tasks t JOIN up ON t.id = up.parent_task_id
     WHERE up.depth < 32
  )
  SELECT schedule_id FROM up WHERE parent_task_id IS NULL LIMIT 1
$$;
