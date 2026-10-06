/**
 * Shared test setup.
 *
 * Cleanup runs as the schema owner over a dedicated connection rather than
 * through the control-plane role. Two reasons: TRUNCATE is a table-owner
 * privilege that production code has no business holding, and the append-only
 * trigger on `events` blocks DELETE even through a cascade -- which is the
 * intended production behaviour (section 7.4 admits no deletion, only freeze
 * and export) and must not be relaxed to make tests convenient.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { connectionString } from '../../src/config.ts';
import { withControlPlane } from '../../src/db/tenant.ts';
import { migrate } from '../../scripts/migrate.ts';
import { clearStopAll } from '../../src/engine/control.ts';

let migrated = false;
let owner: pg.Pool | null = null;

// A transaction is one connection, and a connection runs one query at a time.
// `pg` 8 queues a second query sent while one is running and warns; `pg` 9
// throws. So a `Promise.all` over one transaction's queries is a page that
// works today and fails on the next upgrade -- the company's structure was
// read that way. Every file loads this module, so the warning fails the file
// that caused it, with the stack that says where.
process.traceDeprecation = true;
process.on('warning', (warning) => {
  if (/already executing a query/.test(warning.message)) {
    throw new Error(`two queries at once on one connection: ${warning.stack ?? warning.message}`);
  }
});

function ownerPool(): pg.Pool {
  // The reset empties the append-only tables with the rest, and says so: a
  // TRUNCATE of them is refused to a session that has not (0082).
  owner ??= new pg.Pool({ connectionString: connectionString('owner'), max: 4, options: '-c app.allow_truncate=on' });
  return owner;
}

// A deployment a test boots with no state directory keeps its state -- the
// charters repository, a master key -- in its home, which is this process's
// unless the test names one. Each test file gets a home of its own: tests
// wrote into the home of whoever ran them, and a real deployment on the same
// machine shared what they left.
process.env.HOME = mkdtempSync(join(tmpdir(), 'palugada-test-home-'));

export async function ensureSchema(): Promise<void> {
  if (migrated) return;
  await migrate();
  migrated = true;
}

export async function resetData(): Promise<void> {
  await ensureSchema();
  await clearStopAll();
  // companies cascades to every tenant table; capabilities holds platform
  // registry rows that each test registers for itself. Published bundles are
  // the deployment's too: a bundle one file published -- or one a mutation
  // run let through -- was still there for every later file, and a count of
  // them depended on what had run before.
  await ownerPool().query('TRUNCATE companies, capabilities, bundles CASCADE');

  // The owner's own devices, which are not tenant data either.
  //
  // `owner_authenticators` is platform-scoped -- `company_id` is null for the
  // owner's own phone -- so `TRUNCATE companies CASCADE` never reaches it, and
  // an authenticator enrolled by one test was still there for the next. That
  // was invisible until `enrolTotp` started refusing a secret reference a live
  // authenticator already holds, at which point the second test in a file to
  // enrol `vault://owner/totp` failed. The leak was older than the guard; the
  // guard is what made it say so.
  //
  // Truncated through the *owner* pool rather than the control plane:
  // `owner_authentications` is append-only to `palugada_admin`, which is the
  // right rule -- a record of every second-factor attempt that the console's
  // own role could delete would not be much of a record.
  await ownerPool().query('TRUNCATE owner_authenticators, owner_authentications CASCADE');
  // And the links a deployment with no owner made (0094), which a later file's
  // console would otherwise still honour.
  await ownerPool().query('TRUNCATE owner_claims');

  // The deployment's own settings and sealed secrets (0065): a model one
  // test chose in the console would otherwise be the model every later
  // file's deployment starts on.
  await ownerPool().query('TRUNCATE deployment_settings, deployment_secrets');
  // And the owner's conversation with the assistant (0066).
  await ownerPool().query('TRUNCATE assistant_messages, assistant_proposals');
  // And what WhatsApp delivered and was sent (0085): a message id one file
  // claimed would be a duplicate to every later one.
  await ownerPool().query('TRUNCATE whatsapp_receipts, whatsapp_sent');
  // And Telegram's (0089), for the same reason: each file counts its updates from one.
  await ownerPool().query('TRUNCATE telegram_receipts');
  // And where the traces had got to (0090), which names runs no later file has.
  await ownerPool().query(
    `UPDATE telemetry_cursor SET through_at = '-infinity', through_id = '00000000-0000-0000-0000-000000000000',
            holder = NULL, held_until = '-infinity'`);
  // And which workers said they were alive (0079): a worker a test left
  // running, or a process killed before it could take its word back, would
  // otherwise be a holder every later file's sweep thinks has died.
  await ownerPool().query('TRUNCATE worker_heartbeats, mcp_authorizations, credential_authorizations');
  // And the lines erased companies left (0088), which name companies no
  // later file made.
  await ownerPool().query('TRUNCATE company_erasures');

  // TRUNCATE ... CASCADE empties the whole referencing table, not only the
  // rows that pointed at a company -- so it also removes the platform-default
  // rows (company_id IS NULL) that the migrations seeded. Restoring them keeps
  // each test starting from the state a fresh deployment would have.
  // Inserted through the control plane: both tables carry a SELECT-only policy
  // under FORCE ROW LEVEL SECURITY, so even the table owner cannot write to
  // them. Only the BYPASSRLS role can, which is the same path the migrations
  // and the owner console use.
  await withControlPlane(async (tx) => {
    await tx.query(
      `INSERT INTO alert_thresholds (company_id) SELECT NULL
        WHERE NOT EXISTS (SELECT 1 FROM alert_thresholds WHERE company_id IS NULL)`,
    );
    await tx.query(
      `INSERT INTO retention_policies (company_id) SELECT NULL
        WHERE NOT EXISTS (SELECT 1 FROM retention_policies WHERE company_id IS NULL)`,
    );
    await tx.query(
      `INSERT INTO spend_limits (company_id) SELECT NULL
        WHERE NOT EXISTS (SELECT 1 FROM spend_limits WHERE company_id IS NULL)`,
    );

    // The owner's window, back to the schema's own default.
    //
    // `platform_control` is not tenant data, so it survives the TRUNCATE --
    // and `setOwnerWindow` is how one test checks that a routine escalation
    // waits for waking hours. Left set, that window is inherited by every file
    // that runs afterwards, so what a later test observes depends on which
    // earlier test happened to move it. Order-dependence like that does not
    // fail; it makes a suite pass for a reason nobody wrote down, until the
    // day the order or the clock changes and a green test goes red with no
    // code between the two runs.
    await tx.query(
      `UPDATE platform_control
          SET owner_timezone = 'UTC',
              owner_window_start_hour = 8,
              owner_window_end_hour = 22,
              -- And the languages (0052), for the same reason: a test that sets
              -- the agents' default to Indonesian would otherwise hand it to
              -- every file after it.
              console_language = NULL,
              agent_language = NULL,
              -- And the owner's tour (0064), so each file meets a console that
              -- has not been toured.
              tour_finished_at = NULL,
              -- And the currency the owner reads money in (0106).
              display_currency = NULL,
              display_rate = NULL,
              -- And the window a code opens (0120): none, so that a test of what
              -- asks for a second factor meets a console that asks every time,
              -- as these were written to expect. step-up.test.ts sets its own.
              step_up_minutes = 0`,
    );
  });
}

export async function closeSetup(): Promise<void> {
  await owner?.end();
  owner = null;
}
