/**
 * The standard capability catalogue and its tier calibration (PRD F8.2, F8.3,
 * section 8.8, open question 14.2).
 *
 * Section 14.2 left the first company's line of business open, and with it the
 * initial capabilities and their tier calibration. The owner's answer is that
 * there is no single line of business: PALUGADA runs companies of any kind, so
 * the catalogue is the set of things *every* company does -- correspond, keep
 * records, publish, deploy, invoice, pay -- rather than the vocabulary of one
 * industry. A company in a particular trade adds its own capabilities on top;
 * it does not get a different set of tiers for the ones here.
 *
 * Two things this file is, and one it is not.
 *
 * It is the calibration. Every entry says which tier it sits at and why it is
 * not the neighbouring one, because a tier assigned without a reason is a tier
 * that will drift the first time somebody finds it inconvenient. Where the PRD
 * names an example in its section 8.8 table, the entry says so, and the tier
 * is the document's rather than mine.
 *
 * It is enforced. `assertCalibrated` runs at registration, so an adapter bound
 * at a looser tier than the catalogue states is refused rather than accepted
 * and quietly trusted. A binding may tighten -- that is F8.3 again, one level
 * up: the same rule that stops a grant loosening the registry stops a registry
 * entry loosening the catalogue.
 *
 * It is NOT a set of implementations, and it deliberately does not write
 * itself into the `capabilities` table. A row there means the broker can run
 * the thing, and the table's own constraint requires a read-back for anything
 * above tier 0 (F8.4). Publishing declarations would mean claiming a read-back
 * that does not exist yet, which is the one lie the registry must not be able
 * to tell. Capabilities reach the table through `CapabilityRegistry.sync()`,
 * when a real adapter has been bound to them.
 */
import { PalugadaError } from '../errors.ts';
import { TIER, type Tier } from '../domain/tier.ts';

export interface CapabilityDeclaration {
  name: string;
  /** The adapter family this capability will be bound to. */
  adapter: string;
  tier: Tier;
  summary: string;
  /** Why this tier and not the one above or below it. */
  calibration: string;
  /** Whether running it requires a credential scoped to the division (F12.2). */
  needsCredential?: boolean;
  /**
   * Whether it runs code supplied at call time (F8.10).
   *
   * The database refuses to put such a capability in the same division as a
   * credential or a tier 2 grant, because the sandbox does not isolate the
   * network and therefore cannot stop code from posting either one somewhere.
   */
  executesUntrustedCode?: boolean;
}

/**
 * The catalogue.
 *
 * Ordered by tier so the shape of the boundary is readable: reading costs
 * nothing, drafting is undoable, sending is not, and destroying is the owner's
 * decision alone.
 */
export const STANDARD_CATALOGUE: readonly CapabilityDeclaration[] = [
  // -- Tier 0: read-only. Automatic, briefly logged. -------------------------
  {
    name: 'dns.read',
    adapter: 'dns',
    tier: TIER.READ_ONLY,
    summary: 'Reads the records in a zone.',
    calibration: 'A named tier 0 example in the PRD section 8.8 table.',
  },
  {
    // F4.8. The door back to what did not fit in the context pack, which is
    // what makes capping the pack reasonable rather than lossy.
    name: 'memory.search',
    adapter: 'platform',
    tier: TIER.READ_ONLY,
    summary: "Searches the company's own semantic memory.",
    calibration:
      'A read of the company\'s own store, scoped to the asking division by ' +
      'the same rules the context pack uses. It changes nothing outside the ' +
      'company and nothing inside it either.',
  },
  {
    // F15.7. The pack carries a skill\'s summary; this fetches the document.
    name: 'skill.read',
    adapter: 'platform',
    tier: TIER.READ_ONLY,
    summary: 'Reads the active version of a skill the context pack summarised.',
    calibration:
      'A read of a document the company wrote and approved. Reading a ' +
      'procedure is not an action; following it may be, and whatever it ' +
      'leads to is judged on its own tier.',
  },
  {
    name: 'uptime.check',
    adapter: 'monitoring',
    tier: TIER.READ_ONLY,
    summary: 'Checks whether a service answers.',
    calibration: 'A named tier 0 example in the PRD section 8.8 table.',
  },
  {
    name: 'files.list',
    adapter: 'storage',
    tier: TIER.READ_ONLY,
    summary: 'Lists objects in a bucket or folder.',
    calibration: 'A named tier 0 example in the PRD section 8.8 table.',
  },
  {
    name: 'web.fetch',
    adapter: 'http',
    tier: TIER.READ_ONLY,
    summary: 'Fetches a public page or document.',
    calibration:
      'Reading changes nothing outside. What it returns is external text, so ' +
      'it reaches the model inside the untrusted envelope F8.9 requires -- ' +
      'the risk it carries is injection, not irreversibility.',
  },
  {
    name: 'repo.read',
    adapter: 'vcs',
    tier: TIER.READ_ONLY,
    summary: 'Reads files, history and pull requests in a repository.',
    calibration:
      'Cloning and reading leave nothing behind that anyone has to undo. ' +
      'Writing is `repo.branch`, which is separate so that reading code -- ' +
      'the thing an agent does constantly -- never carries the weight of ' +
      'changing it.',
    needsCredential: true,
  },
  {
    name: 'mailbox.read',
    adapter: 'mail',
    tier: TIER.READ_ONLY,
    summary: 'Reads messages in a company mailbox.',
    calibration:
      'Reading is tier 0 even though the content is sensitive: the tier ' +
      'classifies how hard the effect is to reverse, and confidentiality is ' +
      'the credential scope and the redactor, not the tier.',
    needsCredential: true,
  },
  {
    name: 'calendar.read',
    adapter: 'calendar',
    tier: TIER.READ_ONLY,
    summary: 'Reads the company calendar.',
    calibration:
      'Reading availability changes nothing. Putting something in the ' +
      'calendar is `calendar.hold`, and inviting a person to it is not a ' +
      'calendar action at all but correspondence.',
    needsCredential: true,
  },
  {
    name: 'ledger.read',
    adapter: 'accounting',
    tier: TIER.READ_ONLY,
    summary: 'Reads accounts, invoices and balances.',
    calibration:
      'Reading the books moves no money. It is tier 0 deliberately, so that ' +
      'checking an invoice before paying it is free and there is no incentive ' +
      'to skip the check.',
    needsCredential: true,
  },
  {
    name: 'crm.read',
    adapter: 'crm',
    tier: TIER.READ_ONLY,
    summary: 'Reads customer records and their history.',
    calibration:
      'Reading a record changes nothing about the customer. What it exposes ' +
      'is personal data, which the credential scope and the retention window ' +
      'govern -- the tier governs reversibility, and those are different ' +
      'questions with different answers.',
    needsCredential: true,
  },
  {
    name: 'metrics.read',
    adapter: 'analytics',
    tier: TIER.READ_ONLY,
    summary: 'Reads product and traffic metrics.',
    calibration:
      'A query against an analytics store leaves the store as it was. Cheap ' +
      'enough to run before every decision, which is the point of keeping it ' +
      'at tier 0.',
    needsCredential: true,
  },

  // -- Tier 1: cheap reversible write. Automatic, fully logged, verified. ----
  {
    name: 'doc.draft',
    adapter: 'docs',
    tier: TIER.REVERSIBLE_WRITE,
    summary: 'Writes or edits an internal document.',
    calibration:
      'A named tier 1 example in the PRD section 8.8 table. A draft nobody ' +
      'has been shown is undone by rewriting it.',
    needsCredential: true,
  },
  {
    name: 'dns.update',
    adapter: 'dns',
    tier: TIER.REVERSIBLE_WRITE,
    summary: 'Creates or changes a record in a zone the company controls.',
    calibration:
      'Reversible by writing the previous value back, so tier 1 rather than ' +
      '2 -- but only for records. Changing the nameservers moves the whole ' +
      'zone to another provider and is tier 3, which is why it is a separate ' +
      'capability rather than an argument to this one.',
    needsCredential: true,
  },
  {
    name: 'deploy.staging',
    adapter: 'deploy',
    tier: TIER.REVERSIBLE_WRITE,
    summary: 'Deploys a build to a staging environment.',
    calibration:
      'A named tier 1 example in the PRD section 8.8 table. No customer sees ' +
      'staging, so rolling back costs a redeploy and nothing else.',
    needsCredential: true,
  },
  {
    name: 'repo.branch',
    adapter: 'vcs',
    tier: TIER.REVERSIBLE_WRITE,
    summary: 'Pushes a branch and opens a pull request.',
    calibration:
      'A branch changes nothing until it is merged, and merging to a ' +
      'production branch is a deploy, which is calibrated separately.',
    needsCredential: true,
  },
  {
    name: 'ticket.create',
    adapter: 'tracker',
    tier: TIER.REVERSIBLE_WRITE,
    summary: 'Opens or updates a work item.',
    calibration: 'A ticket can be closed. It reaches colleagues, not customers.',
    needsCredential: true,
  },
  {
    name: 'calendar.hold',
    adapter: 'calendar',
    tier: TIER.REVERSIBLE_WRITE,
    summary: 'Blocks time on the company calendar, inviting nobody.',
    calibration:
      'Deliberately narrower than "schedule a meeting". An invitation reaches ' +
      'a person outside the company and cannot be recalled once read, which ' +
      'is `email.send` at tier 2. A hold on the company\'s own calendar is ' +
      'deleted and forgotten.',
    needsCredential: true,
  },
  {
    name: 'crm.note',
    adapter: 'crm',
    tier: TIER.REVERSIBLE_WRITE,
    summary: 'Adds a note to a customer record.',
    calibration: 'Internal, and editable afterwards.',
    needsCredential: true,
  },
  {
    name: 'email.draft',
    adapter: 'mail',
    tier: TIER.REVERSIBLE_WRITE,
    summary: 'Saves a message as a draft without sending it.',
    calibration:
      'The whole point of the split from `email.send`: a draft is the ' +
      'reversible half of correspondence, so an agent can prepare one ' +
      'automatically and only the sending needs the heavier gate.',
    needsCredential: true,
  },

  // -- Tier 2: costly, slow to undo, or spends money. -----------------------
  {
    name: 'email.send',
    adapter: 'mail',
    tier: TIER.COSTLY,
    summary: 'Sends a message to an external recipient.',
    calibration:
      'A named tier 2 example in the PRD section 8.8 table. Nothing unsends ' +
      'a message that has been read.',
    needsCredential: true,
  },
  {
    name: 'deploy.production',
    adapter: 'deploy',
    tier: TIER.COSTLY,
    summary: 'Deploys a build to production.',
    calibration:
      'A named tier 2 example in the PRD section 8.8 table. A rollback ' +
      'exists, which is what keeps it below tier 3, but the customers who ' +
      'saw the bad build in between are not rolled back with it.',
    needsCredential: true,
  },
  {
    name: 'domain.purchase',
    adapter: 'registrar',
    tier: TIER.COSTLY,
    summary: 'Registers a domain.',
    calibration:
      'A named tier 2 example in the PRD section 8.8 table. It spends money ' +
      'and the registration term is not refundable.',
    needsCredential: true,
  },
  {
    name: 'invoice.pay',
    adapter: 'payments',
    tier: TIER.COSTLY,
    summary: 'Pays an invoice the company owes.',
    calibration:
      'A named tier 2 example in the PRD section 8.8 table. Recovering a ' +
      'payment depends on the recipient agreeing to return it. A transfer ' +
      'that is not settling a known invoice is `funds.transfer`, at tier 3.',
    needsCredential: true,
  },
  {
    name: 'invoice.issue',
    adapter: 'accounting',
    tier: TIER.COSTLY,
    summary: 'Issues an invoice to a customer.',
    calibration:
      'Voiding an invoice is possible but visible: the customer, and often a ' +
      'tax authority, has already seen the number. That is "slow to undo" ' +
      'rather than "cheap to undo".',
    needsCredential: true,
  },
  {
    name: 'ads.campaign.start',
    adapter: 'ads',
    tier: TIER.COSTLY,
    summary: 'Starts or raises the budget of an advertising campaign.',
    calibration:
      'Spends money continuously rather than once, so the gap between the ' +
      'estimate and the actual bill is exactly what F8.5 watches for.',
    needsCredential: true,
  },
  {
    name: 'social.publish',
    adapter: 'social',
    tier: TIER.COSTLY,
    summary: 'Publishes a post on a public account.',
    calibration:
      'Deleting a post does not unpublish it. Who saw it, and who kept a ' +
      'copy, is outside the company\'s control the moment it goes out.',
    needsCredential: true,
  },
  {
    name: 'code.execute',
    adapter: 'sandbox',
    tier: TIER.COSTLY,
    summary: 'Runs a snippet supplied at call time inside the sandbox.',
    calibration:
      'Tier 2 rather than 1 because a tier classifies the effect that is ' +
      'reachable, not the one that is declared, and the sandbox does not ' +
      'isolate the network -- code running in it can still open a ' +
      'connection. Not tier 3, which would need the owner for every snippet ' +
      'and make the capability useless; the missing safety is supplied ' +
      'instead by the rule that no credential and no other tier 2 grant may ' +
      'share its division, which the database enforces.',
    executesUntrustedCode: true,
  },

  // -- Tier 3: irreversible. Always the owner's decision. --------------------
  {
    name: 'dns.nameservers',
    adapter: 'dns',
    tier: TIER.IRREVERSIBLE,
    summary: 'Points a domain at different nameservers.',
    calibration:
      'A named tier 3 example in the PRD section 8.8 table. It moves every ' +
      'record at once, and the company may lose the ability to move it back.',
    needsCredential: true,
  },
  {
    name: 'record.delete',
    adapter: 'storage',
    tier: TIER.IRREVERSIBLE,
    summary: 'Deletes a production record or object.',
    calibration:
      'A named tier 3 example in the PRD section 8.8 table. A backup is not ' +
      'a reversal; it is a hope about a backup.',
    needsCredential: true,
  },
  {
    name: 'domain.transfer',
    adapter: 'registrar',
    tier: TIER.IRREVERSIBLE,
    summary: 'Transfers a domain to another registrar or owner.',
    calibration:
      'A named tier 3 example in the PRD section 8.8 table. Getting it back ' +
      'requires the new holder to agree.',
    needsCredential: true,
  },
  {
    name: 'server.destroy',
    adapter: 'infra',
    tier: TIER.IRREVERSIBLE,
    summary: 'Destroys a server or its storage.',
    calibration:
      'A named tier 3 example in the PRD section 8.8 table. Rebuilding the ' +
      'machine is possible; recovering what was only ever on its disk is not, ' +
      'and nobody discovers which case they are in until afterwards.',
    needsCredential: true,
  },
  {
    name: 'document.sign',
    adapter: 'esign',
    tier: TIER.IRREVERSIBLE,
    summary: 'Signs a document on the company\'s behalf.',
    calibration:
      'A named tier 3 example in the PRD section 8.8 table. A signature ' +
      'binds the owner personally, which is the one thing the platform ' +
      'exists to keep in human hands.',
    needsCredential: true,
  },
  {
    name: 'funds.transfer',
    adapter: 'payments',
    tier: TIER.IRREVERSIBLE,
    summary: 'Transfers money that is not settling a known invoice.',
    calibration:
      'A named tier 3 example in the PRD section 8.8 table. Distinguished ' +
      'from `invoice.pay` by having no invoice to check the amount and the ' +
      'recipient against -- which is precisely what makes it unrecoverable.',
    needsCredential: true,
  },
];

const BY_NAME = new Map(STANDARD_CATALOGUE.map((entry) => [entry.name, entry]));

export function declarationFor(name: string): CapabilityDeclaration | undefined {
  return BY_NAME.get(name);
}

export function catalogueNames(): string[] {
  return [...BY_NAME.keys()];
}

/**
 * Refuses a binding that contradicts the catalogue.
 *
 * A capability the catalogue does not name passes: a company in a particular
 * trade registers capabilities of its own, and the catalogue is a floor for
 * the shared ones rather than a closed list.
 *
 * For a name it does hold, the binding may tighten and never loosen. That is
 * F8.3 one level up -- the rule that stops a grant loosening the registry,
 * applied to the registry loosening the calibration -- and it matters because
 * the tier is the only thing standing between an agent and an irreversible
 * action. A registration is also the last moment anyone reads the tier on
 * purpose; after it, the number is simply believed.
 */
export function assertCalibrated(capability: {
  name: string;
  defaultTier: Tier;
  executesUntrustedCode?: boolean;
}): void {
  const declared = BY_NAME.get(capability.name);
  if (!declared) return;

  if (capability.defaultTier < declared.tier) {
    throw new PalugadaError(
      'capability.miscalibrated',
      `capability ${capability.name} is catalogued at tier ${declared.tier} and cannot be ` +
        `registered at tier ${capability.defaultTier}: ${declared.calibration}`,
      { name: capability.name, catalogued: declared.tier, registered: capability.defaultTier },
    );
  }

  // Not a tier, so "tighten, never loosen" does not apply: a capability either
  // runs code it was handed or it does not, and getting this wrong in either
  // direction breaks the isolation rule the database enforces around it.
  if ((capability.executesUntrustedCode ?? false) !== (declared.executesUntrustedCode ?? false)) {
    throw new PalugadaError(
      'capability.miscalibrated',
      `capability ${capability.name} must declare executesUntrustedCode = ` +
        `${declared.executesUntrustedCode ?? false} to match the catalogue`,
      { name: capability.name },
    );
  }
}
