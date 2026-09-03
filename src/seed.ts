/**
 * What a fresh installation needs before it can do anything (PRD v2 F16.5,
 * F3.11, F4.8).
 *
 * Three things, and each was reachable only from a test until this existed:
 * the built-in bundles have to be in the catalogue before a company can be
 * assembled from them, the charters have to be read off disk before the files
 * are the source of truth rather than a copy, and the capabilities PALUGADA
 * implements itself have to be bound before a run that follows the context
 * pack's instruction to use `memory.search` gets an answer.
 *
 * Seeding is idempotent by content. Publishing a bundle twice replaces the row
 * with an identical one; importing a charter whose text has not changed
 * publishes no version. That matters because this runs on every deploy, and a
 * seed that manufactured a version each time would make "which charter was
 * this run subject to" a question about deploy timing.
 *
 * What it does *not* do is bind an adapter to `email.send`. Those belong to
 * whoever operates the installation, with their own credentials, and a seed
 * that invented them would be shipping a stub into production.
 */
import { CapabilityRegistry } from './broker/registry.ts';
import { registerPlatformCapabilities } from './broker/platform-capabilities.ts';
import { BUILT_IN_BUNDLES } from './bundles/builtin.ts';
import { publishBundle, type Bundle, type SignedBundle } from './bundles/bundle.ts';
import { importFromDisk } from './governance/charter-files.ts';
import { saveTemplate } from './templates/company.ts';
import { STANDARD_COMPANY_TEMPLATE, STANDARD_TEMPLATE_SLUG } from './templates/standard.ts';

export interface SeedOptions {
  /**
   * Where PLATFORM.md and companies/<slug>/SOUL.md live (F3.11).
   *
   * Omitted means charters are not read from disk in this installation, which
   * is a choice rather than a default: a deployment that keeps them elsewhere
   * should say so by not passing this, not by pointing it at a guess.
   */
  charterRoot?: string;
  /**
   * Signed copies of the built-in bundles.
   *
   * Quarantine lifts only for a signature from a publisher this installation
   * trusts (`trustPublisher`), so an installation that wants `web-ops` to hold
   * `dns.update` has to both sign the bundle and add the signing key. Passing
   * nothing is supported and honest: the bundles publish unsigned and install
   * read-only until somebody does both.
   */
  signedBundles?: SignedBundle[];
}

export interface SeedReport {
  bundles: Array<{
    slug: string;
    version: string;
    hash: string;
    /** The signature verifies against the key offered with it. */
    signed: boolean;
    /** That key is one this installation trusts, so the bundle installs freely. */
    trusted: boolean;
  }>;
  charters: Array<{ scope: string; version: number | null }>;
  template: string;
}

/**
 * The registry a deployment starts from.
 *
 * Only the capabilities the platform implements itself. Everything else in the
 * catalogue is a calibrated *name* waiting for an operator's adapter, and
 * `sync()` is deliberately not called here: syncing a registry that holds two
 * of thirty-four capabilities would delete the rest of the catalogue.
 */
export function baseRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registerPlatformCapabilities(registry as never);
  return registry;
}

export async function seed(options: SeedOptions = {}): Promise<SeedReport> {
  const signed = new Map(
    (options.signedBundles ?? []).map((bundle) => [`${bundle.slug}@${bundle.version}`, bundle]),
  );

  const bundles: SeedReport['bundles'] = [];
  for (const builtIn of BUILT_IN_BUNDLES) {
    const toPublish: Bundle | SignedBundle =
      signed.get(`${builtIn.slug}@${builtIn.version}`) ?? builtIn;
    const published = await publishBundle(toPublish);
    bundles.push({
      slug: builtIn.slug,
      version: builtIn.version,
      hash: published.hash,
      signed: published.signed,
      trusted: published.trusted,
    });
  }

  await saveTemplate({
    slug: STANDARD_TEMPLATE_SLUG,
    name: 'Standard company',
    description: 'Function-based divisions that fit any line of business (PRD section 14.2).',
    body: STANDARD_COMPANY_TEMPLATE,
  });

  const charters = options.charterRoot
    ? await importFromDisk({ root: options.charterRoot })
    : [];

  return { bundles, charters, template: STANDARD_TEMPLATE_SLUG };
}
