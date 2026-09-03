/**
 * Bundles (PRD v2 F16.1, F16.2, F16.3, F16.5, F2.6, F12.10).
 *
 * A bundle is a versioned package of the things that are only coherent
 * together: roles, the skills they follow, the hooks that constrain them, the
 * capability grants that let them act, the policies that stop them, and the
 * heartbeat schedule that wakes them. A role without its grants cannot do
 * anything; a grant without its policy is a hole; a skill without the role it
 * was written for is advice nobody asked for. Shipping them separately is how
 * a working configuration becomes six half-applied ones.
 *
 * **Signed, and the hash recorded at install (F16.2).** The signature says who
 * published it. The hash says whether what is installed is still what they
 * published -- which is the question people actually ask, and they ask it after
 * something has gone wrong. So the hash is stored on the installation and never
 * updated: if the bundle row is ever edited, the difference becomes visible
 * rather than merely unlikely.
 *
 * **Unsigned means quarantine (F12.10).** Not refusal. A bundle nobody has
 * vouched for can still be useful and can still be inspected, so it installs
 * with tier 0 grants only -- it may read and may not change anything. The
 * question quarantine answers is not "is this code malicious" but "has anybody
 * said it is not", and the honest answer for an unsigned package is no.
 *
 * The canonical serialisation is deliberately simple: keys sorted, no
 * whitespace. A hash that depended on key order would change when a
 * serialiser did, and a signature nobody can reproduce is a signature nobody
 * checks.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { withControlPlane, withTenant } from '../db/tenant.ts';
import { appendEvent } from '../audit/event-log.ts';
import { PalugadaError } from '../errors.ts';
import { TIER } from '../domain/tier.ts';
import type { CompanyTemplate, TemplateGrant, TemplateRole } from '../templates/company.ts';
import type { Hook, HookName, HookPipeline } from '../engine/hooks.ts';

export interface BundleSkill {
  slug: string;
  /** The SKILL.md, whole. */
  source: string;
  scope: 'division' | 'company';
  division?: string;
  evals: Array<{ name: string; input: Record<string, unknown>; expectContains: string[] }>;
}

/**
 * A hook a bundle brings (F14.4).
 *
 * Declarative rather than code. A bundle that could ship a function would be
 * shipping arbitrary execution into the enforcement path, which is the one
 * place the platform cannot allow a third party -- F14.4 says a bundle hook runs
 * sandboxed and holds no secret, and the cheapest sandbox is a hook that cannot
 * express anything but a refusal.
 */
export interface BundleHook {
  name: string;
  on: HookName;
  /**
   * The division this hook constrains. Omitted means the whole company.
   *
   * Needed because a company is assembled from several bundles: `qa-review`'s
   * "a reviewer may not write" is about the review division, and a hook that
   * applied company-wide would stop every other bundle's roles from working
   * the moment somebody installed a reviewer.
   */
  division?: string;
  /** Refuse when the capability matches and the tier is at least this. */
  refuseCapability?: string;
  refuseAtOrAboveTier?: number;
  reason: string;
}

export interface BundleSchedule {
  roleSlug: string;
  /** F9.7: how often this role wakes, in minutes. */
  heartbeatMinutes: number;
}

export interface BundleBody {
  divisions: CompanyTemplate['divisions'];
  roles: TemplateRole[];
  grants: TemplateGrant[];
  policies: Array<{
    slug: string;
    scope: 'company' | 'division';
    division?: string;
    condition: string;
    effect: string;
    params?: Record<string, unknown>;
  }>;
  skills: BundleSkill[];
  hooks: BundleHook[];
  schedules: BundleSchedule[];
}

export interface Bundle {
  slug: string;
  version: string;
  name: string;
  description: string;
  body: BundleBody;
}

export interface SignedBundle extends Bundle {
  signature: string;
  signedBy: string;
  /** The publisher's public key, PEM. Public, so storing it gives nothing away. */
  publisherKey: string;
}

/**
 * The bytes a hash and a signature are taken over.
 *
 * Keys sorted, no whitespace, `undefined` dropped. Anything that depends on key
 * order or formatting would change when a serialiser did, and a hash nobody can
 * reproduce is a hash nobody checks.
 */
export function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalise(nested)}`).join(',')}}`;
}

export function hashBundle(bundle: Bundle): string {
  return createHash('sha256')
    .update(canonicalise({
      slug: bundle.slug,
      version: bundle.version,
      name: bundle.name,
      description: bundle.description,
      body: bundle.body,
    }))
    .digest('hex');
}

/**
 * Checks a signature against the publisher's key.
 *
 * The signature is over the hash rather than the document, so verifying does
 * not depend on the verifier serialising the document the same way the signer
 * did -- it depends on them hashing it the same way, which `canonicalise` makes
 * true by construction.
 */
export function verifyBundleSignature(bundle: SignedBundle): boolean {
  try {
    const key = createPublicKey(bundle.publisherKey);
    const edwards = key.asymmetricKeyType === 'ed25519' || key.asymmetricKeyType === 'ed448';
    return verify(
      edwards ? null : 'sha256',
      Buffer.from(hashBundle(bundle)),
      key,
      Buffer.from(bundle.signature, 'base64'),
    );
  } catch {
    return false;
  }
}

/**
 * Stores a bundle. Signed or not -- publishing is not installing.
 *
 * A signature that does not verify is refused outright, though, because an
 * invalid signature is worse than none: it is a claim of provenance that is
 * false, and storing it would let the quarantine check pass on a document
 * nobody signed.
 */
export async function publishBundle(bundle: Bundle | SignedBundle): Promise<{
  id: string;
  hash: string;
  signed: boolean;
}> {
  assertBundleIsCoherent(bundle);
  const hash = hashBundle(bundle);
  const signed = 'signature' in bundle;

  if (signed && !verifyBundleSignature(bundle)) {
    throw new PalugadaError(
      'bundle.bad_signature',
      `the signature on ${bundle.slug}@${bundle.version} does not verify against its key`,
      { slug: bundle.slug, version: bundle.version },
    );
  }

  const id = await withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO bundles
         (slug, version, name, description, body, content_hash, signature, signed_by, publisher_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (slug, version) DO UPDATE
         SET name = EXCLUDED.name, description = EXCLUDED.description,
             body = EXCLUDED.body, content_hash = EXCLUDED.content_hash,
             signature = EXCLUDED.signature, signed_by = EXCLUDED.signed_by,
             publisher_key = EXCLUDED.publisher_key
       RETURNING id`,
      [
        bundle.slug,
        bundle.version,
        bundle.name,
        bundle.description,
        JSON.stringify(bundle.body),
        hash,
        signed ? bundle.signature : null,
        signed ? bundle.signedBy : null,
        signed ? bundle.publisherKey : null,
      ],
    );
    return rows[0]!.id;
  });

  return { id, hash, signed };
}

export interface InstalledBundle {
  slug: string;
  version: string;
  hash: string;
  quarantined: boolean;
  roles: string[];
  skills: string[];
}

/**
 * Installs a bundle into a company (F16.3, F2.6, F12.10).
 *
 * An unsigned bundle installs quarantined, and quarantine is enforced on the
 * grants rather than remembered as a flag: a tier 1 grant in an unsigned bundle
 * simply is not created. A flag somebody has to check is a flag somebody
 * eventually does not.
 */
export async function installBundle(input: {
  companyId: string;
  slug: string;
  version: string;
}): Promise<InstalledBundle> {
  const stored = await withControlPlane(async (tx) => {
    const { rows } = await tx.query<{
      id: string;
      body: BundleBody;
      content_hash: string;
      signature: string | null;
    }>(
      'SELECT id, body, content_hash, signature FROM bundles WHERE slug = $1 AND version = $2',
      [input.slug, input.version],
    );
    return rows[0] ?? null;
  });

  if (!stored) {
    throw new PalugadaError(
      'bundle.unknown',
      `there is no bundle ${input.slug}@${input.version}`,
      { slug: input.slug, version: input.version },
    );
  }

  const quarantined = stored.signature === null;
  const body = stored.body;

  const installed = await withTenant(input.companyId, async (tx) => {
    const divisionIds = new Map<string, string>();
    for (const division of body.divisions) {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO divisions (company_id, slug, name, max_concurrency)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (company_id, slug) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [input.companyId, division.slug, division.name, division.maxConcurrency ?? 4],
      );
      divisionIds.set(division.slug, rows[0]!.id);
    }

    // F2.6: a role can be created from a bundle.
    const roleSlugs: string[] = [];
    for (const role of body.roles) {
      const divisionId = divisionIds.get(role.division);
      if (!divisionId) {
        throw new PalugadaError(
          'bundle.invalid',
          `role ${role.slug} names division ${role.division}, which the bundle does not define`,
          { slug: input.slug },
        );
      }
      const heartbeat = body.schedules.find((schedule) => schedule.roleSlug === role.slug);
      await tx.query(
        `INSERT INTO roles
           (company_id, division_id, slug, system_prompt, model, tools,
            input_schema, output_schema, max_tokens_per_run, done_criteria,
            heartbeat_minutes)
         VALUES ($1,$2,$3,$4,$5,$6::text[],$7,$8,$9,$10::text[],$11)
         ON CONFLICT (company_id, slug) DO UPDATE
           SET system_prompt = EXCLUDED.system_prompt,
               model = EXCLUDED.model,
               tools = EXCLUDED.tools,
               done_criteria = EXCLUDED.done_criteria,
               heartbeat_minutes = EXCLUDED.heartbeat_minutes`,
        [
          input.companyId,
          divisionId,
          role.slug,
          role.systemPrompt,
          role.model,
          role.tools ?? [],
          JSON.stringify(role.inputSchema ?? {}),
          JSON.stringify(role.outputSchema ?? { type: 'object' }),
          role.maxTokensPerRun ?? 40_000,
          role.doneCriteria ?? ['the run returns an output matching its schema'],
          heartbeat?.heartbeatMinutes ?? 240,
        ],
      );
      roleSlugs.push(role.slug);
    }

    for (const grant of body.grants) {
      const tier = grant.tierOverride ?? null;
      // F12.10: quarantine is tier 0. A grant above it is not created at all,
      // rather than created and checked later.
      if (quarantined && (tier === null || tier > TIER.READ_ONLY)) continue;

      const divisionId = divisionIds.get(grant.division);
      if (!divisionId) continue;
      await tx.query(
        `INSERT INTO capability_grants
           (company_id, division_id, capability_name, tier_override, rate_limit_per_hour)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (division_id, capability_name) DO UPDATE
           SET tier_override = EXCLUDED.tier_override,
               rate_limit_per_hour = EXCLUDED.rate_limit_per_hour`,
        [input.companyId, divisionId, grant.capability, tier, grant.rateLimitPerHour ?? null],
      );
    }

    await tx.query(
      `INSERT INTO bundle_installs
         (company_id, bundle_id, slug, version, installed_hash, quarantined)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (company_id, slug) DO UPDATE
         SET bundle_id = EXCLUDED.bundle_id, version = EXCLUDED.version,
             installed_hash = EXCLUDED.installed_hash,
             quarantined = EXCLUDED.quarantined,
             installed_at = now()`,
      [input.companyId, stored.id, input.slug, input.version, stored.content_hash, quarantined],
    );

    await appendEvent(tx, {
      companyId: input.companyId,
      type: 'bundle.installed',
      actor: 'owner',
      payload: {
        slug: input.slug,
        version: input.version,
        hash: stored.content_hash,
        quarantined,
      },
    });

    return { roleSlugs, divisionIds };
  });

  // The bundle's skills go in as candidates, not as active skills. F15.3 is
  // not waived by the knowledge arriving in a package: somebody still has to
  // review it and the owner still has to approve it, and a bundle that could
  // activate its own skills would be a way to put text in front of every agent
  // without anybody reading it.
  const skills = await installSkills(input.companyId, body, input.slug);

  return {
    slug: input.slug,
    version: input.version,
    hash: stored.content_hash,
    quarantined,
    roles: installed.roleSlugs,
    skills,
  };
}

/**
 * Tells a running pipeline that a company's bundles have changed.
 *
 * Separate from `installBundle` because the pipeline is a process's object and
 * the install is a database fact: a second process finds out when its own cache
 * expires, which is the sixty seconds `COMPANY_HOOK_CACHE_MS` allows. This is
 * for the process that did the installing, so an owner who installs a bundle
 * and immediately runs a task sees its hooks.
 */
export function forgetBundleHooks(pipeline: HookPipeline, companyId: string): void {
  pipeline.forget(companyId);
}

async function installSkills(
  companyId: string,
  body: BundleBody,
  bundleSlug: string,
): Promise<string[]> {
  const { addEvalCase, proposeSkillVersion } = await import('../skills/skills.ts');
  const installed: string[] = [];

  for (const skill of body.skills) {
    const divisionId =
      skill.scope === 'division' && skill.division
        ? await withTenant(companyId, async (tx) => {
            const { rows } = await tx.query<{ id: string }>(
              'SELECT id FROM divisions WHERE company_id = $1 AND slug = $2',
              [companyId, skill.division],
            );
            return rows[0]?.id ?? null;
          })
        : null;

    const proposed = await proposeSkillVersion({
      companyId,
      slug: skill.slug,
      scopeType: skill.scope,
      scopeId: divisionId,
      source: skill.source,
      author: 'bundle',
      changelog: `Installed from bundle ${bundleSlug}.`,
    });

    // F15.4: the evals travel with the skill, so it is activatable at all.
    for (const evalCase of skill.evals) {
      await addEvalCase(companyId, proposed.skillId, evalCase);
    }
    installed.push(skill.slug);
  }

  return installed;
}

/**
 * F16.2's question, asked later: is what is installed still what was published?
 *
 * Re-derives the hash from the stored body and compares it with what was
 * recorded at install. A mismatch means somebody edited the bundle row after
 * the fact, which is exactly the case a hash exists to catch.
 */
export async function verifyInstall(
  companyId: string,
  slug: string,
): Promise<{ intact: boolean; installedHash: string; currentHash: string } | null> {
  const install = await withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ bundle_id: string; installed_hash: string }>(
      'SELECT bundle_id, installed_hash FROM bundle_installs WHERE slug = $1',
      [slug],
    );
    return rows[0] ?? null;
  });
  if (!install) return null;

  const current = await withControlPlane(async (tx) => {
    const { rows } = await tx.query<{
      slug: string; version: string; name: string; description: string; body: BundleBody;
    }>(
      'SELECT slug, version, name, description, body FROM bundles WHERE id = $1',
      [install.bundle_id],
    );
    return rows[0] ?? null;
  });
  if (!current) {
    return { intact: false, installedHash: install.installed_hash, currentHash: '' };
  }

  const currentHash = hashBundle(current);
  return {
    intact: currentHash === install.installed_hash,
    installedHash: install.installed_hash,
    currentHash,
  };
}

export function assertBundleIsCoherent(bundle: Bundle): void {
  const divisions = new Set(bundle.body.divisions.map((division) => division.slug));

  for (const role of bundle.body.roles) {
    if (!divisions.has(role.division)) {
      throw new PalugadaError(
        'bundle.invalid',
        `role ${role.slug} names division ${role.division}, which the bundle does not define`,
        { slug: bundle.slug },
      );
    }
  }
  for (const grant of bundle.body.grants) {
    if (!divisions.has(grant.division)) {
      throw new PalugadaError(
        'bundle.invalid',
        `a grant names division ${grant.division}, which the bundle does not define`,
        { slug: bundle.slug },
      );
    }
  }
  for (const hook of bundle.body.hooks) {
    if (hook.refuseCapability === undefined && hook.refuseAtOrAboveTier === undefined) {
      // A hook with no condition refuses everything. That is a configuration
      // error rather than a strict policy, and catching it here is the
      // difference between a bundle that fails to publish and a company that
      // cannot do anything.
      throw new PalugadaError(
        'bundle.invalid',
        `hook ${hook.name} names neither a capability nor a tier, so it would refuse ` +
          'every action',
        { slug: bundle.slug, hook: hook.name },
      );
    }
  }

  const roleSlugs = new Set(bundle.body.roles.map((role) => role.slug));
  for (const schedule of bundle.body.schedules) {
    if (!roleSlugs.has(schedule.roleSlug)) {
      throw new PalugadaError(
        'bundle.invalid',
        `a heartbeat names role ${schedule.roleSlug}, which the bundle does not define`,
        { slug: bundle.slug },
      );
    }
  }
}


/**
 * Turns a bundle's declared hook into one the pipeline can run (F14.4).
 *
 * The declaration is data, so this is the only place a bundle's intent becomes
 * behaviour, and it is deliberately the narrowest possible translation: a
 * bundle hook can refuse and can do nothing else. It is handed no transaction,
 * no secret and no way to reach the outside -- F14.4 asks for a sandbox, and a
 * function that can only return `{allow: false}` is the smallest one there is.
 *
 * It is also, by construction, subject to F14.2: an added hook may only
 * tighten. A bundle cannot widen anything by shipping a hook, because there is
 * no shape in `BundleHook` that says "permit".
 */
export function bundleHook(
  declaration: BundleHook,
  scope: { divisionId: string | null } = { divisionId: null },
): Hook {
  return {
    name: declaration.name,
    on: declaration.on,
    async run(ctx) {
      // A division-scoped hook says nothing about anybody else's division.
      if (scope.divisionId !== null && ctx.divisionId !== scope.divisionId) {
        return { allow: true };
      }

      const capabilityMatches =
        declaration.refuseCapability === undefined
        || declaration.refuseCapability === ctx.capability;
      const tierMatches =
        declaration.refuseAtOrAboveTier === undefined
        || (ctx.tier !== undefined && ctx.tier >= declaration.refuseAtOrAboveTier);

      // A hook that declared neither condition would refuse everything, which
      // is a configuration error rather than a policy. It is refused at publish
      // time by `assertBundleIsCoherent`, so reaching here means at least one
      // condition is set.
      return capabilityMatches && tierMatches
        ? { allow: false, reason: declaration.reason }
        : { allow: true };
    },
  };
}


/**
 * The hooks a company's installed bundles bring (F14.4).
 *
 * A quarantined bundle's hooks still apply. That is not an oversight: a hook
 * can only refuse, so an unsigned bundle's hooks make the company *more*
 * restricted, and dropping them because nobody vouched for the package would
 * be dropping a restriction on the grounds that it might not be trustworthy.
 */
export async function installedBundleHooks(companyId: string): Promise<Hook[]> {
  const installs = await withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ bundle_id: string }>(
      'SELECT bundle_id FROM bundle_installs',
    );
    return rows.map((row) => row.bundle_id);
  });
  if (installs.length === 0) return [];

  const bodies = await withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ body: BundleBody }>(
      'SELECT body FROM bundles WHERE id = ANY($1::uuid[])',
      [installs],
    );
    return rows.map((row) => row.body);
  });

  const divisionIds = await withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string; slug: string }>(
      'SELECT id, slug FROM divisions',
    );
    return new Map(rows.map((row) => [row.slug, row.id]));
  });

  return bodies.flatMap((body) =>
    (body.hooks ?? []).flatMap((declaration) => {
      if (declaration.division === undefined) {
        return [bundleHook(declaration)];
      }
      const divisionId = divisionIds.get(declaration.division);
      // The division the hook constrains is not in this company -- the bundle
      // was installed and its division later removed, or renamed. Dropping the
      // hook is right: it has nothing to constrain, and guessing at another
      // division would apply a restriction nobody asked for.
      return divisionId ? [bundleHook(declaration, { divisionId })] : [];
    }),
  );
}
