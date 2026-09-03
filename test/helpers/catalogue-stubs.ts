/**
 * Stub adapters for the standard catalogue.
 *
 * The catalogue is a calibration, not a set of implementations, so nothing in
 * `src/` binds an adapter to `email.send`. A test that needs a company built
 * from the standard template still needs those names to exist in the registry,
 * so it binds a stub here.
 *
 * These live in `test/` deliberately. A stub that answers `{ ok: true }` to
 * every call and verifies itself is exactly the thing that must never be
 * reachable from production code by an import away.
 */
import {
  STANDARD_CATALOGUE,
  type CapabilityDeclaration,
} from '../../src/broker/catalogue.ts';
import { CapabilityRegistry, type Capability } from '../../src/broker/registry.ts';

export function stubCapability(declaration: CapabilityDeclaration): Capability<unknown, unknown> {
  return {
    name: declaration.name,
    adapter: `stub:${declaration.adapter}`,
    defaultTier: declaration.tier,
    executesUntrustedCode: declaration.executesUntrustedCode ?? false,
    async execute() {
      return { ok: true };
    },
    async verify() {
      return true;
    },
  };
}

/** Registers a stub for every catalogued capability and syncs the registry. */
export async function registerStandardCatalogue(): Promise<CapabilityRegistry> {
  const registry = new CapabilityRegistry();
  for (const declaration of STANDARD_CATALOGUE) {
    registry.register(stubCapability(declaration));
  }
  await registry.sync();
  return registry;
}
