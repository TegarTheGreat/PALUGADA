/**
 * PRD F4.1, F4.2, F4.3, F4.6 -- memory scope and versioning.
 *
 * Acceptance criterion F4.2: a similarity query for company A, using an
 * embedding identical to one of company B's facts, never returns company B's
 * fact -- demonstrated with a thousand facts spread across companies.
 *
 * Using an identical embedding is the point. A perfect match scores a distance
 * of zero, so if the boundary leaked at all, the foreign fact would not merely
 * appear somewhere in the results: it would rank first.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { recall, remember, supersede } from '../../src/memory/store.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const DIMENSION = 1536;
const MODEL = 'test-embedding-v1';

/**
 * Deterministic sparse embedding.
 *
 * Sparse so a thousand of them stay cheap to build and send, deterministic so
 * a failure is reproducible, and never all-zero because cosine distance is
 * undefined for a zero vector.
 */
function embeddingFor(seed: number): number[] {
  const vector = new Array<number>(DIMENSION).fill(0);
  for (let i = 0; i < 8; i += 1) {
    vector[(seed * 37 + i * 191) % DIMENSION] = ((seed % 17) + i + 1) / 20;
  }
  return vector;
}

async function seedFacts(fixture: Fixture, count: number, seedOffset: number): Promise<void> {
  await withTenant(fixture.companyId, async (tx) => {
    for (let i = 0; i < count; i += 1) {
      const seed = seedOffset + i;
      await remember(tx, {
        companyId: fixture.companyId,
        memoryType: 'semantic',
        scopeType: 'division',
        scopeId: fixture.divisionId,
        body: `fact-${seed} for ${fixture.slug}`,
        embedding: embeddingFor(seed),
        embeddingModel: MODEL,
      });
    }
  });
}

test('a similarity query never crosses a company boundary (F4.2 acceptance)', async () => {
  const companyA = await createCompany('memory-a');
  const companyB = await createCompany('memory-b');

  // A thousand facts, split across two tenants.
  await seedFacts(companyA, 500, 0);
  await seedFacts(companyB, 500, 500);

  const total = await withTenant(companyA.companyId, async (tx) => {
    const { rows } = await tx.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM memories',
    );
    return Number(rows[0]!.count);
  });
  assert.equal(total, 500, 'company A can only see its own half of the thousand');

  // The exact embedding of one of company B's facts.
  const targetSeed = 742;
  const targetEmbedding = embeddingFor(targetSeed);

  const asCompanyA = await withTenant(companyA.companyId, (tx) =>
    recall(tx, companyA.companyId, {
      memoryType: 'semantic',
      divisionId: companyA.divisionId,
      embedding: targetEmbedding,
      embeddingModel: MODEL,
      limit: 25,
    }),
  );

  assert.ok(asCompanyA.length > 0, 'company A should still get its own nearest facts');
  for (const item of asCompanyA) {
    assert.ok(
      item.body.endsWith(companyA.slug),
      `company A received a fact belonging to another tenant: ${item.body}`,
    );
  }
  assert.ok(
    !asCompanyA.some((item) => item.body.startsWith(`fact-${targetSeed} `)),
    'the exact-match fact from company B must not appear at any rank',
  );

  // The same query run as company B does find it, which proves the fact exists
  // and the query is capable of matching it -- so company A's empty result is
  // the boundary working, not the search failing.
  const asCompanyB = await withTenant(companyB.companyId, (tx) =>
    recall(tx, companyB.companyId, {
      memoryType: 'semantic',
      divisionId: companyB.divisionId,
      embedding: targetEmbedding,
      embeddingModel: MODEL,
      limit: 1,
    }),
  );
  assert.equal(asCompanyB.length, 1);
  assert.ok(asCompanyB[0]!.body.startsWith(`fact-${targetSeed} `));
  assert.ok((asCompanyB[0]!.distance ?? 1) < 1e-6, 'an identical embedding should score ~0 distance');
});

test('semantic memory is walled off per division unless shared (F4.6)', async () => {
  const fixture = await createCompany('memory-divisions');

  const otherDivisionId = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO divisions (company_id, slug, name) VALUES ($1, 'growth', 'Growth') RETURNING id`,
      [fixture.companyId],
    );
    return rows[0]!.id;
  });

  await withTenant(fixture.companyId, async (tx) => {
    await remember(tx, {
      companyId: fixture.companyId,
      memoryType: 'semantic',
      scopeType: 'division',
      scopeId: otherDivisionId,
      body: 'growth-only fact',
    });
    await remember(tx, {
      companyId: fixture.companyId,
      memoryType: 'semantic',
      scopeType: 'division',
      scopeId: otherDivisionId,
      body: 'explicitly shared fact',
      shared: true,
    });
    await remember(tx, {
      companyId: fixture.companyId,
      memoryType: 'semantic',
      scopeType: 'company',
      body: 'company-wide fact',
    });
  });

  const visible = await withTenant(fixture.companyId, (tx) =>
    recall(tx, fixture.companyId, { memoryType: 'semantic', divisionId: fixture.divisionId }),
  );
  const bodies = visible.map((item) => item.body).sort();

  assert.deepEqual(
    bodies,
    ['company-wide fact', 'explicitly shared fact'],
    "another division's private fact must not be visible; shared and company-wide ones must be",
  );
});

test('a corrected fact supersedes rather than deletes (F4.3)', async () => {
  const fixture = await createCompany('memory-supersede');
  const past = new Date(Date.now() - 60_000);

  const { originalId, replacementId } = await withTenant(fixture.companyId, async (tx) => {
    const originalId = await remember(tx, {
      companyId: fixture.companyId,
      memoryType: 'semantic',
      scopeType: 'division',
      scopeId: fixture.divisionId,
      body: 'the hosting provider is Alpha',
      validFrom: past,
    });
    const replacementId = await supersede(tx, originalId, {
      companyId: fixture.companyId,
      memoryType: 'semantic',
      scopeType: 'division',
      scopeId: fixture.divisionId,
      body: 'the hosting provider is Beta',
    });
    return { originalId, replacementId };
  });

  const now = await withTenant(fixture.companyId, (tx) =>
    recall(tx, fixture.companyId, { memoryType: 'semantic', divisionId: fixture.divisionId }),
  );
  assert.equal(now.length, 1);
  assert.equal(now[0]!.body, 'the hosting provider is Beta');

  // The superseded fact is still there and still answerable as of the time it
  // was believed. That is the difference between a system that learns and one
  // that merely changes its mind and forgets it did.
  const then = await withTenant(fixture.companyId, (tx) =>
    recall(tx, fixture.companyId, {
      memoryType: 'semantic',
      divisionId: fixture.divisionId,
      asOf: new Date(past.getTime() + 1000),
    }),
  );
  assert.equal(then.length, 1);
  assert.equal(then[0]!.body, 'the hosting provider is Alpha');

  const rowCount = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM memories',
    );
    return Number(rows[0]!.count);
  });
  assert.equal(rowCount, 2, 'nothing was deleted');
  assert.notEqual(originalId, replacementId);
});

test('embeddings from different models are never compared', async () => {
  // Vectors from two models occupy unrelated spaces. Comparing them produces
  // confident nonsense rather than an error, so the model is part of the
  // filter and a mismatch simply returns nothing.
  const fixture = await createCompany('memory-models');

  await withTenant(fixture.companyId, async (tx) => {
    await remember(tx, {
      companyId: fixture.companyId,
      memoryType: 'semantic',
      scopeType: 'division',
      scopeId: fixture.divisionId,
      body: 'stored under model v1',
      embedding: embeddingFor(1),
      embeddingModel: MODEL,
    });
  });

  const sameModel = await withTenant(fixture.companyId, (tx) =>
    recall(tx, fixture.companyId, {
      memoryType: 'semantic',
      divisionId: fixture.divisionId,
      embedding: embeddingFor(1),
      embeddingModel: MODEL,
    }),
  );
  assert.equal(sameModel.length, 1);

  const otherModel = await withTenant(fixture.companyId, (tx) =>
    recall(tx, fixture.companyId, {
      memoryType: 'semantic',
      divisionId: fixture.divisionId,
      embedding: embeddingFor(1),
      embeddingModel: 'some-other-model',
    }),
  );
  assert.equal(otherModel.length, 0);

  await assert.rejects(
    () =>
      withTenant(fixture.companyId, (tx) =>
        remember(tx, {
          companyId: fixture.companyId,
          memoryType: 'semantic',
          scopeType: 'company',
          body: 'no model declared',
          embedding: embeddingFor(2),
        }),
      ),
    /must be stored with the model/,
  );
});

test('episodic memory is shared per project (F4.6)', async () => {
  const fixture = await createCompany('memory-episodic');

  const otherProjectId = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO projects (company_id, slug, name) VALUES ($1, 'side', 'Side') RETURNING id`,
      [fixture.companyId],
    );
    return rows[0]!.id;
  });

  await withTenant(fixture.companyId, async (tx) => {
    await remember(tx, {
      companyId: fixture.companyId,
      memoryType: 'episodic',
      scopeType: 'project',
      scopeId: fixture.projectId,
      body: 'main project episode',
    });
    await remember(tx, {
      companyId: fixture.companyId,
      memoryType: 'episodic',
      scopeType: 'project',
      scopeId: otherProjectId,
      body: 'side project episode',
    });
  });

  const mainOnly = await withTenant(fixture.companyId, (tx) =>
    recall(tx, fixture.companyId, { memoryType: 'episodic', projectId: fixture.projectId }),
  );
  assert.deepEqual(mainOnly.map((item) => item.body), ['main project episode']);
});
