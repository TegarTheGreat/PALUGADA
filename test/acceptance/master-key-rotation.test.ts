/**
 * Rotating the master key that seals the console's secrets.
 *
 * Every key the owner typed into the console -- the model's, a channel's, a
 * vendor's -- is sealed under one master key. A key that has to change (it
 * was in a backup that leaked, the operator who held it left) had no way to
 * change: a new PALUGADA_MASTER_KEY left every sealed secret unopenable, and
 * the only way forward was to type each of them again. Now the old key is
 * named beside the new one, and the deployment reseals everything under the
 * new key when it starts.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane } from '../../src/db/tenant.ts';
import { InMemorySecretManager } from '../../src/secrets/manager.ts';
import {
  DeploymentSecretManager, masterKeyFrom, previousMasterKeysFrom, putSecret, resealSecrets, type MasterKey,
} from '../../src/settings/store.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

function key(): { hex: string; master: MasterKey } {
  const hex = randomBytes(32).toString('hex');
  return { hex, master: masterKeyFrom({ PALUGADA_MASTER_KEY: hex })! };
}

const keyIds = async () => (await withControlPlane((tx) => tx.query<{ name: string; key_id: string }>(
  'SELECT name, key_id FROM deployment_secrets ORDER BY name'))).rows;

test('with the old key named beside the new, every secret opens, and boot reseals each under the new key', async () => {
  const old = key();
  const fresh = key();
  const lost = key();
  await putSecret('model-key', 'sk-model-0123456789abcdef', old.master);
  await putSecret('channel-telegram', '123456:telegram-token-abcdef', old.master);
  await putSecret('channel-slack', 'https://hooks.slack.test/lost-one', lost.master);

  // Between the restart and the reseal -- another replica not yet restarted --
  // an old secret still opens with the old key named.
  const bridging = new DeploymentSecretManager(new InMemorySecretManager(), () => fresh.master, () => [old.master]);
  assert.equal(await bridging.resolve('db://model-key'), 'sk-model-0123456789abcdef');

  const { start } = await import('../../src/main.ts');
  const deployment = await start({
    port: 0,
    env: { PALUGADA_MASTER_KEY: fresh.hex, PALUGADA_MASTER_KEY_PREVIOUS: ` ${old.hex} ` },
    log: () => undefined,
  });
  try {
    const notes = deployment.notes.join('\n');
    assert.match(notes, new RegExp(`resealed 2 secrets under the master key ${fresh.master.id}`));
    assert.match(notes, new RegExp(`db://channel-slack is sealed with the master key ${lost.master.id}, which is neither`));
  } finally {
    await deployment.stop();
  }

  assert.deepEqual(await keyIds(), [
    { name: 'channel-slack', key_id: lost.master.id },
    { name: 'channel-telegram', key_id: fresh.master.id },
    { name: 'model-key', key_id: fresh.master.id },
  ]);
  // The new key alone opens them now, with the same values.
  const after = new DeploymentSecretManager(new InMemorySecretManager(), () => fresh.master);
  assert.equal(await after.resolve('db://model-key'), 'sk-model-0123456789abcdef');
  assert.equal(await after.resolve('db://channel-telegram'), '123456:telegram-token-abcdef');
  const oldOnly = new DeploymentSecretManager(new InMemorySecretManager(), () => old.master);
  await assert.rejects(oldOnly.resolve('db://model-key'), /sealed with the master key/, 'the old key opens nothing any more');

  // Done once: the next start has nothing left to reseal.
  assert.deepEqual(await resealSecrets(fresh.master, [old.master]), {
    resealed: 0, unopened: [{ name: 'channel-slack', keyId: lost.master.id }],
  });
});

test('an old key that is not a key is refused by name, before anything is resealed', () => {
  assert.throws(() => previousMasterKeysFrom({ PALUGADA_MASTER_KEY_PREVIOUS: 'too-short' }),
    /PALUGADA_MASTER_KEY_PREVIOUS holds a key that is not 32 bytes/);
  const one = key();
  const two = key();
  assert.deepEqual(previousMasterKeysFrom({ PALUGADA_MASTER_KEY_PREVIOUS: `${one.hex}, ${two.hex}` }).map((found) => found.id),
    [one.master.id, two.master.id]);
  assert.deepEqual(previousMasterKeysFrom({}), []);
});
