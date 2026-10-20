-- The owner holding a company's browser (STATUS 2.122).
--
-- To sign in, to type a code a site sent to their phone, to answer a
-- puzzle, the owner takes the company's browser over from the console with
-- their device. While they hold it, the company's work waits rather than
-- reading or acting under their hands, on every replica, which is why the
-- hold is a row and not a flag in one process. A hold nobody has touched for
-- fifteen minutes has lapsed: work goes on, and the owner takes it over
-- again to go on typing.

CREATE TABLE browser_holds (
  company_id  uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  held_since  timestamptz NOT NULL DEFAULT now(),
  -- The owner's last input, which keeps the hold from lapsing.
  touched_at  timestamptz NOT NULL DEFAULT now()
);

SELECT app.enable_tenant_rls('browser_holds');

-- The owner's, from the console on the control plane: work only looks.
REVOKE INSERT, UPDATE, DELETE ON browser_holds FROM palugada_app;
