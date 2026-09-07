/**
 * `doc.draft` and `email.draft` -- writing something down, and sending nothing
 * (PRD v2 F8.2, §8.8, NG6).
 *
 * The catalogue calibrates both at tier 1, not tier 0, and the first version of
 * this file got that wrong. It returned text and stored nothing, which felt
 * safer -- and `assertCalibrated` refused to register it, correctly. A tier is
 * not a measure of how careful the implementation feels: §8.8 puts a draft at
 * tier 1 because a draft is a **write that can be undone by rewriting**, and a
 * capability that stores nothing is not that capability at all. It also has
 * nothing to `verify()`, which tier 1 requires, and a required read-back with
 * nothing to read back is the shape of a rule being worked around.
 *
 * So these write. The store is the company's own files directory -- the same
 * root `files.list` reads -- rather than a documents provider, because that is
 * the part that needs somebody's account and this does not. A deployment with
 * Google Docs or a real mailbox binds a different implementation of the same
 * name; this one is what a company gets before it has chosen.
 *
 * **The name is the platform's, never the caller's.** A capability that let a
 * role choose the filename would be a capability that lets a role choose
 * `../../etc/cron.d/anything`. The slug comes from the brief, the uniqueness
 * from the idempotency key the engine already minted, and traversal is not
 * defended against so much as made unreachable.
 *
 * **This is not the engine calling a model to do a task.** NG6 says PALUGADA
 * orchestrates and does not execute, and drafting prose sits close to that
 * line. It is on the right side: the *runtime* decided to draft something and
 * called a tool, exactly as it would call `dns.read`. The engine decided
 * nothing. The difference is who holds the reins.
 */
import { PalugadaError } from '../errors.ts';
import type { Capability, CapabilityContext } from '../broker/registry.ts';
import type { LlmClient } from '../llm/client.ts';

export interface DraftOptions {
  llm: LlmClient;
  /**
   * The company's files, the same root `files.list` reads.
   *
   * Required. A draft that went somewhere the owner cannot find is a draft
   * that was not written, and there is no directory this platform may pick on
   * a company's behalf.
   */
  root: string;
  model?: string;
  maxTokens?: number;
}

export interface DocDraftInput {
  brief: string;
  context?: string;
  /** A hint, not a contract: 'memo', 'proposal', 'summary'. */
  kind?: string;
}

export interface DocDraftOutput {
  /** Relative to the company's files, because host paths are nobody's business. */
  path: string;
  text: string;
  words: number;
  model: string;
}

const DOC_SYSTEM = [
  'You draft a document from a brief.',
  '',
  'Return the document and nothing else: no preamble, no explanation of what',
  'you did, no offer to revise it. What you return is stored verbatim, so a',
  'sentence about the draft becomes part of the draft.',
  '',
  'Write only what the brief supports. Where a fact is missing, say what is',
  'missing in one line rather than inventing it: a draft that reads as',
  'complete and is not is worse than one that names its gap, because only the',
  'second gets fixed.',
].join('\n');

export function docDraft(options: DraftOptions): Capability<DocDraftInput, DocDraftOutput> {
  const model = options.model ?? 'draft-model';
  let lastCostCents: number | null = null;

  return {
    name: 'doc.draft',
    adapter: 'platform:draft',
    // Tier 1, as §8.8 calibrates it. It writes, and rewriting undoes it.
    defaultTier: 1,
    async execute(input, ctx) {
      const answer = await options.llm.complete(
        {
          model,
          system: DOC_SYSTEM,
          messages: [{
            role: 'user',
            content: [
              input.kind ? `Kind: ${input.kind}` : null,
              `Brief: ${String(input.brief ?? '').trim()}`,
              input.context ? `Context:\n${input.context}` : null,
            ].filter(Boolean).join('\n\n'),
          }],
          maxTokens: options.maxTokens ?? 2_000,
        },
        ctx.signal,
      );
      lastCostCents = answer.costCents;

      const path = await write(
        options.root,
        `${slug(input.brief)}-${short(ctx)}.md`,
        answer.content,
      );
      return {
        path,
        text: answer.content,
        words: answer.content.trim().split(/\s+/).filter(Boolean).length,
        model,
      };
    },
    /**
     * F8.4: read the external state back.
     *
     * Not a formality. A write that reported success and left nothing on disk
     * -- a full volume, a permission the process lost, a store that accepted
     * the call and dropped it -- is exactly the failure a read-back catches
     * and a return code does not.
     */
    async verify(_input, result) {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const stored = await readFile(join(options.root, result.path), 'utf8').catch(() => null);
      return stored === result.text;
    },
    async actualCostCents() {
      return lastCostCents;
    },
  };
}

export interface EmailDraftInput {
  to: string;
  subject?: string;
  brief: string;
  context?: string;
}

export interface EmailDraftOutput {
  path: string;
  to: string;
  subject: string;
  body: string;
  model: string;
}

const EMAIL_SYSTEM = [
  'You draft an email from a brief.',
  '',
  'Return exactly two parts, in this order and nothing else:',
  'Subject: <one line>',
  '<a blank line>',
  '<the body>',
  '',
  'The body is what a person would actually send: no placeholders in square',
  'brackets, no "insert name here", no note to the sender. If the brief does',
  'not give you something the email needs, write the email without it and say',
  'so in one final line beginning "Missing:".',
].join('\n');

export function emailDraft(options: DraftOptions): Capability<EmailDraftInput, EmailDraftOutput> {
  const model = options.model ?? 'draft-model';
  let lastCostCents: number | null = null;

  return {
    name: 'email.draft',
    adapter: 'platform:draft',
    // Tier 1, and the gap to `email.send`'s tier is the whole point of the
    // split: a draft is the reversible half of correspondence.
    defaultTier: 1,
    async execute(input, ctx) {
      const answer = await options.llm.complete(
        {
          model,
          system: EMAIL_SYSTEM,
          messages: [{
            role: 'user',
            content: [
              `To: ${String(input.to ?? '').trim()}`,
              input.subject ? `Suggested subject: ${input.subject}` : null,
              `Brief: ${String(input.brief ?? '').trim()}`,
              input.context ? `Context:\n${input.context}` : null,
            ].filter(Boolean).join('\n\n'),
          }],
          maxTokens: options.maxTokens ?? 1_200,
        },
        ctx.signal,
      );
      lastCostCents = answer.costCents;

      const { subject, body } = splitEmail(answer.content, input.subject ?? '');
      const to = String(input.to ?? '');
      const path = await write(
        options.root,
        `email-${slug(subject || to)}-${short(ctx)}.eml`,
        // Stored as a message rather than as prose, so what the owner opens is
        // the thing that would be sent rather than a description of it.
        `To: ${to}\nSubject: ${subject}\n\n${body}\n`,
      );
      return { path, to, subject, body, model };
    },
    describe(input) {
      // F3.4. A policy saying "no drafts addressed outside our domain" needs
      // the domain from the capability, which makes the *draft* governable
      // rather than only the send.
      const to = String(input.to ?? '');
      const at = to.lastIndexOf('@');
      return { recipientDomain: at === -1 ? null : to.slice(at + 1).toLowerCase() };
    },
    async verify(_input, result) {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const stored = await readFile(join(options.root, result.path), 'utf8').catch(() => null);
      return stored !== null && stored.includes(result.body);
    },
    async actualCostCents() {
      return lastCostCents;
    },
  };
}

/**
 * Writes a draft under the company's files, and answers with the relative path.
 *
 * The directory is fixed and the filename is built here, never taken from the
 * caller. That is not a traversal *defence* -- it is the absence of a place to
 * put one, which is the stronger arrangement: there is no input that reaches
 * this join.
 */
async function write(root: string, name: string, content: string): Promise<string> {
  const { mkdir, writeFile, realpath } = await import('node:fs/promises');
  const { join, resolve } = await import('node:path');

  const base = await realpath(resolve(root)).catch(() => {
    throw new PalugadaError(
      'capability.unknown',
      `drafting is configured with a root that does not exist: ${root}`,
      {},
    );
  });
  const directory = join(base, 'drafts');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, name), content, { encoding: 'utf8', mode: 0o600 });
  return join('drafts', name);
}

/**
 * A filename from a brief.
 *
 * Everything outside a small allow-list becomes a hyphen. An allow-list rather
 * than a deny-list because the input is prose written by an agent, and the
 * question "which characters are dangerous in a filename" has a different
 * answer on every filesystem -- while "which are safe" has the same short one
 * everywhere.
 */
export function slug(text: string): string {
  const cleaned = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || 'draft';
}

/** Enough of the idempotency key to make two drafts of one brief distinct. */
function short(ctx: CapabilityContext): string {
  return ctx.idempotencyKey.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'x';
}

/**
 * Reads the model's answer back into a subject and a body.
 *
 * Tolerant on purpose. A model that ignored the format still produced
 * something a person can send, and refusing it would turn a formatting slip
 * into a failed task. What is not tolerated is silence -- an empty body comes
 * back empty rather than as the subject repeated, because "it wrote nothing"
 * is a fact the role needs.
 */
export function splitEmail(content: string, fallbackSubject: string): {
  subject: string;
  body: string;
} {
  const text = String(content ?? '').trim();
  const match = text.match(/^subject:\s*(.+?)\s*(?:\n|$)/i);
  if (!match) return { subject: fallbackSubject, body: text };
  return {
    subject: match[1]!.trim(),
    body: text.slice(match[0].length).trim(),
  };
}
