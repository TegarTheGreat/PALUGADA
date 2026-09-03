/**
 * Skills and the curated learning loop (PRD v2 F15).
 *
 * Principle 12 divides what an agent is given in two, and this is the half
 * that is *not* enforcement. A hook is a rule the runtime cannot get past; a
 * skill is knowledge it can read, ignore, or get wrong. Keeping the two apart
 * is the whole point: a rule that must be obeyed may not live only in a
 * prompt, and knowledge that only lives in code cannot be improved by the
 * people doing the work.
 *
 * The document is an open-format SKILL.md -- YAML front matter, then a body.
 * PALUGADA stores it whole rather than shredded into columns, so that
 * exporting a skill is a copy rather than a rendering, and so that a company's
 * accumulated knowledge is not hostage to the orchestrator that happened to
 * collect it (F15.1).
 *
 * The loop, and the two gates that make it a loop rather than a drift:
 *
 *   1. Somebody proposes a version -- the owner, a distillation pass, or an
 *      agent that noticed something. It is a *candidate* and reaches nobody.
 *   2. A different role reviews it against explicit criteria (F7, F15.3).
 *   3. The owner approves it (F15.3 again -- review is necessary and not
 *      sufficient; a company's standing instructions are the owner's).
 *   4. It becomes active, and only then does it reach a context pack.
 *
 * A skill with no eval case cannot be activated (F15.4). That is enforced by a
 * trigger in the database rather than here, because a skill with no eval is a
 * claim nobody has ever checked, and a check that lives in one code path stops
 * being a check the day somebody adds a second one.
 *
 * Context packs carry summaries only (F15.7). Section 9 caps a run's context;
 * a company with forty skills would spend all of it on documents the run may
 * not open. `readSkill` is the tool that opens one.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { withTenant, type TenantClient } from '../db/tenant.ts';
import { appendEvent } from '../audit/event-log.ts';
import { PalugadaError } from '../errors.ts';
import * as inbox from '../inbox/inbox.ts';

export type SkillScope = 'division' | 'company' | 'platform';
export type SkillAuthor = 'owner' | 'distillation' | 'agent' | 'bundle';
export type SkillVersionState =
  | 'candidate'
  | 'rejected'
  | 'approved'
  | 'active'
  | 'superseded';

export interface SkillSummary {
  id: string;
  slug: string;
  scopeType: SkillScope;
  scopeId: string | null;
  summary: string;
  activeVersion: number | null;
  /** F15.8: this arrived from outside and nobody here has vouched for it. */
  quarantined: boolean;
  origin: string | null;
}

export interface SkillDocument {
  name: string;
  description: string;
  body: string;
  /** Anything else the front matter carried, kept so a round trip is lossless. */
  metadata: Record<string, string>;
}

/* ------------------------------------------------------------- the format --- */

/**
 * Reads a SKILL.md.
 *
 * Deliberately a small parser rather than a YAML dependency. The front matter
 * a skill needs is flat `key: value` lines, and a parser that accepts exactly
 * that will refuse a document using anchors, references or nested maps --
 * which is the right answer, because those are the parts of YAML that turn a
 * document into a program.
 */
export function parseSkillDocument(source: string): SkillDocument {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new PalugadaError('skill.invalid', 'a skill must begin with YAML front matter', {});
  }

  const metadata: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const separator = line.indexOf(':');
    if (separator === -1 || /^\s/.test(line)) {
      throw new PalugadaError(
        'skill.invalid',
        `front matter must be flat "key: value" lines; got ${JSON.stringify(line)}`,
        {},
      );
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, '');
    metadata[key] = value;
  }

  const name = metadata.name ?? '';
  const description = metadata.description ?? '';
  if (!name || !description) {
    throw new PalugadaError(
      'skill.invalid',
      'a skill must declare a name and a description in its front matter',
      { name, description },
    );
  }

  const body = match[2]!.trim();
  if (!body) {
    throw new PalugadaError('skill.invalid', `skill ${name} has no body`, { name });
  }

  return { name, description, body, metadata };
}

/** Writes a SKILL.md back out. `parse(render(x))` returns `x`. */
export function renderSkillDocument(document: SkillDocument): string {
  const front = { name: document.name, description: document.description, ...document.metadata };
  const lines = Object.entries(front).map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join('\n')}\n---\n\n${document.body}\n`;
}

/* --------------------------------------------------------------- the loop --- */

export interface ProposeInput {
  companyId: string;
  slug: string;
  scopeType: SkillScope;
  scopeId?: string | null;
  /** The SKILL.md, whole. */
  source: string;
  author: SkillAuthor;
  changelog: string;
}

export interface ProposedVersion {
  skillId: string;
  versionId: string;
  version: number;
  inboxItemId: string;
}

/**
 * Proposes a version. It is a candidate and reaches nobody (F15.3).
 *
 * The inbox item is raised here rather than by the caller so that there is no
 * path that creates a candidate without telling the owner one exists. A
 * candidate nobody knows about is indistinguishable from a candidate nobody
 * wanted.
 */
export async function proposeSkillVersion(input: ProposeInput): Promise<ProposedVersion> {
  const document = parseSkillDocument(input.source);

  const proposed = await withTenant(input.companyId, async (tx) => {
    const { rows: existing } = await tx.query<{ id: string; scope_type: SkillScope }>(
      'SELECT id, scope_type FROM skills WHERE company_id = $1 AND slug = $2',
      [input.companyId, input.slug],
    );

    let skillId = existing[0]?.id;
    if (!skillId) {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO skills (company_id, slug, scope_type, scope_id, summary)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [
          input.companyId,
          input.slug,
          input.scopeType,
          input.scopeId ?? null,
          document.description.slice(0, 400),
        ],
      );
      skillId = rows[0]!.id;
    } else if (existing[0]!.scope_type !== input.scopeType) {
      // F15.6: a new version is not the place to widen a skill's reach. Doing
      // it here would let "edit the wording" and "let three more divisions
      // follow this" be the same request.
      throw new PalugadaError(
        'skill.scope_change',
        `skill ${input.slug} is scoped to ${existing[0]!.scope_type}; changing scope is a ` +
          'tier 3 action and goes through promoteSkill',
        { slug: input.slug },
      );
    }

    const { rows: next } = await tx.query<{ version: number }>(
      'SELECT coalesce(max(version), 0) + 1 AS version FROM skill_versions WHERE skill_id = $1',
      [skillId],
    );
    const version = next[0]!.version;

    const { rows: created } = await tx.query<{ id: string }>(
      `INSERT INTO skill_versions
         (company_id, skill_id, version, body, author, changelog)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [input.companyId, skillId, version, input.source, input.author, input.changelog],
    );

    await appendEvent(tx, {
      companyId: input.companyId,
      type: 'skill.proposed',
      actor: input.author === 'owner' ? 'owner' : 'system',
      payload: { slug: input.slug, version, author: input.author },
    });

    return { skillId, versionId: created[0]!.id, version };
  });

  const inboxItemId = await inbox.proposeSkill({
    companyId: input.companyId,
    skillVersionId: proposed.versionId,
    slug: input.slug,
    version: proposed.version,
    author: input.author,
    changelog: input.changelog,
    summary: document.description,
  });

  return { ...proposed, inboxItemId };
}

/** Records that a reviewer has judged this version (F15.3, first gate). */
export async function recordSkillReview(
  companyId: string,
  versionId: string,
  verdict: { approved: boolean; reviewRequestId?: string; reason?: string },
): Promise<void> {
  await withTenant(companyId, async (tx) => {
    if (!verdict.approved) {
      await tx.query(
        `UPDATE skill_versions
            SET state = 'rejected', rejected_reason = $2, reviewed_at = now(),
                review_request_id = coalesce($3, review_request_id)
          WHERE id = $1 AND state = 'candidate'`,
        [versionId, verdict.reason ?? 'the reviewer rejected it', verdict.reviewRequestId ?? null],
      );
      return;
    }
    await tx.query(
      `UPDATE skill_versions
          SET reviewed_at = now(), review_request_id = coalesce($2, review_request_id)
        WHERE id = $1 AND state = 'candidate'`,
      [versionId, verdict.reviewRequestId ?? null],
    );
  });
}

/**
 * The owner's decision, and the activation it unlocks (F15.3, second gate).
 *
 * Refuses a version the reviewer has not seen. The order is not decoration:
 * an owner asked to approve something no other role has examined is being
 * asked to be the review, which is the arrangement F7 exists to avoid.
 */
export async function approveSkillVersion(
  companyId: string,
  versionId: string,
): Promise<{ activated: boolean; version: number }> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      skill_id: string;
      version: number;
      state: SkillVersionState;
      reviewed_at: Date | null;
    }>(
      'SELECT skill_id, version, state, reviewed_at FROM skill_versions WHERE id = $1',
      [versionId],
    );
    const row = rows[0];
    if (!row) throw new PalugadaError('skill.unknown', `no skill version ${versionId}`, {});

    if (row.state !== 'candidate') {
      throw new PalugadaError(
        'skill.invalid',
        `skill version ${versionId} is ${row.state} and cannot be approved`,
        { state: row.state },
      );
    }
    if (row.reviewed_at === null) {
      throw new PalugadaError(
        'review.required',
        'a skill version must be reviewed by another role before the owner approves it (F15.3)',
        { versionId },
      );
    }

    // Supersede first: the unique index allows one active version per skill,
    // and the new row's activation would collide with the old one otherwise.
    await tx.query(
      `UPDATE skill_versions SET state = 'superseded'
        WHERE skill_id = $1 AND state = 'active'`,
      [row.skill_id],
    );
    await tx.query(
      `UPDATE skill_versions
          SET state = 'active', approved_at = now(), activated_at = now()
        WHERE id = $1`,
      [versionId],
    );
    await tx.query('UPDATE skills SET active_version = $2 WHERE id = $1', [
      row.skill_id,
      row.version,
    ]);

    await appendEvent(tx, {
      companyId,
      type: 'skill.activated',
      actor: 'owner',
      payload: { skillId: row.skill_id, version: row.version },
    });

    return { activated: true, version: row.version };
  });
}

/**
 * F15.6: widening a skill's reach.
 *
 * Not a function that does the widening -- one that says what widening is. The
 * change is a tier 3 action, which means it goes through the broker and the
 * owner, like every other tier 3. Calling this without an owner decision is
 * refused rather than quietly performed.
 */
export function isPromotion(from: SkillScope, to: SkillScope): boolean {
  const reach: Record<SkillScope, number> = { division: 0, company: 1, platform: 2 };
  return reach[to] > reach[from];
}

/**
 * Where a skill applies.
 *
 * Narrowing to a division has to name one. That is not a formality: a skill
 * that used to apply company-wide does not have an obvious home division to
 * fall back to, and picking one by guesswork would quietly put a rule in front
 * of a team nobody chose.
 */
export type SkillScopeTarget =
  | { scopeType: 'division'; scopeId: string }
  | { scopeType: 'company' | 'platform' };

export async function setSkillScope(
  companyId: string,
  skillId: string,
  target: SkillScopeTarget,
  options: { ownerApproved: boolean },
): Promise<void> {
  await withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      scope_type: SkillScope;
      slug: string;
      quarantined: boolean;
    }>(
      'SELECT scope_type, slug, quarantined FROM skills WHERE id = $1',
      [skillId],
    );
    const row = rows[0];
    if (!row) throw new PalugadaError('skill.unknown', `no skill ${skillId}`, {});

    // F15.8: a quarantined skill cannot be widened at all, approved or not.
    // The owner's route is to lift the quarantine -- which is a decision about
    // whether they vouch for where it came from -- and then to widen it. Two
    // decisions, because they are two questions.
    if (row.quarantined && isPromotion(row.scope_type, target.scopeType)) {
      throw new PalugadaError(
        'skill.quarantined',
        `${row.slug} arrived from outside and is quarantined; lift the quarantine before ` +
          'widening its scope (F15.8)',
        { skillId, from: row.scope_type, to: target.scopeType },
      );
    }

    if (isPromotion(row.scope_type, target.scopeType) && !options.ownerApproved) {
      throw new PalugadaError(
        'approval.required',
        `promoting ${row.slug} from ${row.scope_type} to ${target.scopeType} is a tier 3 ` +
          'action (F15.6)',
        { skillId, from: row.scope_type, to: target.scopeType },
      );
    }

    await tx.query('UPDATE skills SET scope_type = $2, scope_id = $3 WHERE id = $1', [
      skillId,
      target.scopeType,
      target.scopeType === 'division' ? target.scopeId : null,
    ]);
    await appendEvent(tx, {
      companyId,
      type: 'skill.scope_changed',
      actor: 'owner',
      payload: { skillId, from: row.scope_type, to: target.scopeType },
    });
  });
}

/* ------------------------------------------------------------ eval cases --- */

export async function addEvalCase(
  companyId: string,
  skillId: string,
  evalCase: { name: string; input: Record<string, unknown>; expectContains: string[] },
): Promise<string> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO skill_evals (company_id, skill_id, name, input, expect_contains)
       VALUES ($1, $2, $3, $4, $5::text[])
       ON CONFLICT (skill_id, name) DO UPDATE
         SET input = EXCLUDED.input, expect_contains = EXCLUDED.expect_contains
       RETURNING id`,
      [companyId, skillId, evalCase.name, JSON.stringify(evalCase.input), evalCase.expectContains],
    );
    return rows[0]!.id;
  });
}

export interface EvalOutcome {
  name: string;
  passed: boolean;
  missing: string[];
}

/**
 * Runs a version's eval cases against its own text (F15.5).
 *
 * A skill is a document, so its eval asks whether the document still says the
 * things it was activated for. That is a weaker check than running the skill
 * through a model and judging the result, and it is the one that can run in CI
 * in a second without a provider. It catches the failure that actually happens
 * -- a rewrite that drops the constraint everyone relied on -- which is worth
 * more than a stronger check nobody runs.
 */
export async function runSkillEvals(
  companyId: string,
  versionId: string,
): Promise<{ passed: boolean; cases: EvalOutcome[] }> {
  return withTenant(companyId, async (tx) => {
    const { rows: version } = await tx.query<{ skill_id: string; body: string }>(
      'SELECT skill_id, body FROM skill_versions WHERE id = $1',
      [versionId],
    );
    const row = version[0];
    if (!row) throw new PalugadaError('skill.unknown', `no skill version ${versionId}`, {});

    const { rows: cases } = await tx.query<{ name: string; expect_contains: string[] }>(
      'SELECT name, expect_contains FROM skill_evals WHERE skill_id = $1 ORDER BY name',
      [row.skill_id],
    );

    const haystack = row.body.toLowerCase();
    const outcomes = cases.map((evalCase) => {
      const missing = evalCase.expect_contains.filter(
        (needle) => !haystack.includes(needle.toLowerCase()),
      );
      return { name: evalCase.name, passed: missing.length === 0, missing };
    });

    return {
      // No cases is not a pass. F15.4 refuses activation without one, and an
      // empty set reporting success would be the loophole that rule exists to
      // close.
      passed: outcomes.length > 0 && outcomes.every((outcome) => outcome.passed),
      cases: outcomes,
    };
  });
}

/**
 * F15.5: a candidate whose evals fail is rejected without asking anybody.
 *
 * Automatic because the alternative is an owner being asked to approve a
 * document that has already failed its own test, which teaches them that the
 * test does not mean anything.
 */
export async function screenCandidate(
  companyId: string,
  versionId: string,
): Promise<{ rejected: boolean; cases: EvalOutcome[] }> {
  const result = await runSkillEvals(companyId, versionId);
  if (result.passed) return { rejected: false, cases: result.cases };

  const failing = result.cases.filter((outcome) => !outcome.passed);
  await withTenant(companyId, async (tx) => {
    await tx.query(
      `UPDATE skill_versions
          SET state = 'rejected', rejected_reason = $2
        WHERE id = $1 AND state = 'candidate'`,
      [
        versionId,
        failing.length > 0
          ? `eval failed: ${failing.map((outcome) => outcome.name).join(', ')}`
          : 'the skill has no eval case, so nothing has ever checked what it claims',
      ],
    );
    await appendEvent(tx, {
      companyId,
      type: 'skill.candidate_rejected',
      actor: 'system',
      payload: { versionId, failing: failing.map((outcome) => outcome.name) },
    });
  });
  return { rejected: true, cases: result.cases };
}

/* ------------------------------------------------------ external skills --- */

export interface ImportExternalSkillInput {
  companyId: string;
  slug: string;
  /** The SKILL.md as it arrived. */
  source: string;
  /** Where from: a hub name, a catalogue id, a URL. Kept for the record. */
  origin: string;
  /** The division that asked for it. Required: quarantine means one division. */
  divisionId: string;
  /** Base64. Absent means unsigned, which means quarantine (F12.10). */
  signature?: string;
  /** The publisher's public key, PEM. Public, so holding it gives nothing away. */
  publisherKey?: string;
}

/**
 * The only way a skill from outside this company gets in (F15.8).
 *
 * F15.8 says an external skill enters only through quarantine, and names
 * F12.10 — whose answer for a device or a bundle is "tier 0 only". A skill has
 * no tier; it is a document. So quarantine means scope here, and the analogue
 * is exact: F12.10's rule is that an unvouched-for thing may not reach past a
 * read, and for knowledge, reaching too far means being put in front of every
 * agent in the company. A quarantined skill applies to one division, and the
 * database refuses anything wider.
 *
 * A valid signature lifts the quarantine. An *invalid* one is refused outright
 * rather than downgraded to unsigned: a false claim of provenance is worse
 * than no claim, and accepting it as merely unvouched-for would reward
 * forging one.
 *
 * Everything else is unchanged. An imported skill is still a candidate, still
 * needs a reviewer and the owner (F15.3), and still needs an eval case before
 * it can be activated (F15.4). Quarantine is a fourth constraint, not a
 * replacement for the other three.
 */
export async function importExternalSkill(
  input: ImportExternalSkillInput,
): Promise<ProposedVersion & { quarantined: boolean }> {
  const document = parseSkillDocument(input.source);

  const signed = input.signature !== undefined && input.publisherKey !== undefined;
  if (signed && !verifyDetachedSignature(input.publisherKey!, input.source, input.signature!)) {
    throw new PalugadaError(
      'skill.bad_signature',
      `the signature on ${input.slug} does not verify against the key it was offered with`,
      { slug: input.slug, origin: input.origin },
    );
  }

  const proposed = await proposeSkillVersion({
    companyId: input.companyId,
    slug: input.slug,
    scopeType: 'division',
    scopeId: input.divisionId,
    source: input.source,
    author: 'bundle',
    changelog: `Imported from ${input.origin}${signed ? ', signed' : ', unsigned'}.`,
  });

  await withTenant(input.companyId, async (tx) => {
    await tx.query(
      `UPDATE skills
          SET provenance = 'external', origin = $2, quarantined = $3
        WHERE id = $1`,
      [proposed.skillId, input.origin, !signed],
    );
    await appendEvent(tx, {
      companyId: input.companyId,
      type: 'skill.imported',
      actor: 'owner',
      payload: {
        slug: input.slug,
        origin: input.origin,
        signed,
        quarantined: !signed,
        // The document's own hash, so "is this still what arrived" stays
        // answerable after somebody edits the row.
        contentHash: hashSkillSource(input.source),
      },
    });
  });

  return { ...proposed, quarantined: !signed };
}

/**
 * Lifts a quarantine (F15.8).
 *
 * The owner's decision, and a different question from "may this apply more
 * widely" — which is why it is a different function. Vouching for where a
 * document came from and deciding who should follow it are two judgements, and
 * collapsing them would mean the second is made by whoever makes the first.
 */
export async function liftSkillQuarantine(
  companyId: string,
  skillId: string,
  options: { ownerApproved: boolean },
): Promise<void> {
  if (!options.ownerApproved) {
    throw new PalugadaError(
      'approval.required',
      'lifting a skill quarantine is vouching for something from outside, which is the owner\'s',
      { skillId },
    );
  }

  await withTenant(companyId, async (tx) => {
    await tx.query('UPDATE skills SET quarantined = false WHERE id = $1', [skillId]);
    await appendEvent(tx, {
      companyId,
      type: 'skill.quarantine_lifted',
      actor: 'owner',
      payload: { skillId },
    });
  });
}

/** The bytes a detached skill signature is taken over. */
export function hashSkillSource(source: string): string {
  return createHash('sha256').update(source.trim()).digest('hex');
}

function verifyDetachedSignature(
  publicKeyPem: string,
  source: string,
  signatureBase64: string,
): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    const edwards = key.asymmetricKeyType === 'ed25519' || key.asymmetricKeyType === 'ed448';
    return verify(
      edwards ? null : 'sha256',
      Buffer.from(hashSkillSource(source)),
      key,
      Buffer.from(signatureBase64, 'base64'),
    );
  } catch {
    // A malformed key or signature has failed to verify. Reading the throw as
    // anything else would make a broken signature the easiest one to present.
    return false;
  }
}

/* --------------------------------------------------- progressive disclosure --- */

/**
 * The summaries a run's context pack carries (F15.7).
 *
 * Scoped the way memory is: the division's own skills, plus the company's,
 * plus the platform's. A skill a division cannot see is one somebody scoped
 * deliberately, and widening that silently at read time would make F15.6
 * pointless.
 */
export async function skillSummariesFor(
  tx: TenantClient,
  scope: { companyId: string; divisionId?: string | null },
): Promise<SkillSummary[]> {
  const { rows } = await tx.query<{
    id: string;
    slug: string;
    scope_type: SkillScope;
    scope_id: string | null;
    summary: string;
    active_version: number | null;
    quarantined: boolean;
    origin: string | null;
  }>(
    `SELECT id, slug, scope_type, scope_id, summary, active_version, quarantined, origin
       FROM skills
      WHERE company_id = $1
        AND active_version IS NOT NULL
        AND (scope_type <> 'division' OR scope_id = $2)
      ORDER BY scope_type, slug`,
    [scope.companyId, scope.divisionId ?? null],
  );
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    summary: row.summary,
    activeVersion: row.active_version,
    quarantined: row.quarantined,
    origin: row.origin,
  }));
}

/** F15.7's `skill.read`: the full document, on request. */
export async function readSkill(
  companyId: string,
  slug: string,
): Promise<{ slug: string; version: number; source: string } | null> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ version: number; body: string }>(
      `SELECT v.version, v.body
         FROM skill_versions v
         JOIN skills s ON s.id = v.skill_id
        WHERE s.company_id = $1 AND s.slug = $2 AND v.state = 'active'`,
      [companyId, slug],
    );
    const row = rows[0];
    return row ? { slug, version: row.version, source: row.body } : null;
  });
}
