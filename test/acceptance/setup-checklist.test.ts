/**
 * The first thing a new deployment needs is a model, and the console says so
 * (the owner's complaint of 6 October: "onboarding tidak jelas").
 *
 * The checklist a deployment reports when it starts is mostly optional things
 * switched off -- a push channel, an email channel -- in the operator's words.
 * The console answered every one of them with the same button, "Set the
 * model", whether a model was set or not, and with no company yet it did not
 * mention the model at all: an owner started a company, gave it work, and met
 * a refused key (or no key) as a failed run. The one note that stops every role
 * from working is now said apart from the rest.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const NO_MODEL = 'no model: run `npm run setup`, or set PALUGADA_MODEL_KEY_REF (Anthropic) -- until then no role on the in-process runtime can work (F13.1)';
const A_MODEL = 'model: openai at https://openrouter.ai/api/v1, roles name a tier and run on standard = some/model';
const NO_PUSH = 'no push channel: set PALUGADA_PUSH_URL (F10.5)';

test('a deployment with no model says so, apart from what is merely optional', async () => {
  const api = await consoleWithSettings({ deploymentNotes: [NO_MODEL, NO_PUSH] });
  try {
    const token = await api.signIn();
    const setup = (await api.call('GET', '/api/control/setup', token)).body;
    assert.equal(setup.modelMissing, true);
    assert.deepEqual(setup.todo, [NO_MODEL, NO_PUSH]);
  } finally {
    await api.close();
  }
});

test('one that has a model does not, whatever else is switched off', async () => {
  const api = await consoleWithSettings({ deploymentNotes: [A_MODEL, NO_PUSH] });
  try {
    const token = await api.signIn();
    const setup = (await api.call('GET', '/api/control/setup', token)).body;
    assert.equal(setup.modelMissing, false);
    assert.deepEqual(setup.todo, [NO_PUSH], 'the model is done, the push channel is not');
  } finally {
    await api.close();
  }
});
