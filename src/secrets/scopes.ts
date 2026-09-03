/**
 * Least privilege on third-party tokens (PRD F12.6).
 *
 * The requirement is one line and it was graded nowhere: it appeared in no
 * column of the status table for long enough that nothing in the repository
 * cited it. What can be enforced here is half of it, and the half that is
 * missing is worth saying first.
 *
 * PALUGADA holds a reference and never a value (F12.1), so it cannot ask a
 * provider what a token really carries. Only the issuer knows that. So the
 * enforcement is over *declarations*, and it works because the declaration is
 * squeezed from both ends:
 *
 *   - The database refuses a credential declaring a scope that no capability
 *     its division holds actually needs. Over-declaring is not available.
 *   - This function refuses a capability whose `requiredScopes` are not
 *     covered by the credential it is about to use. Under-declaring is not
 *     available either -- it just moves the failure here, where it says why.
 *
 * Between the two, the only declaration that lets work happen is the true one.
 * That is not the same as verifying the token, and this file does not pretend
 * it is; what it does is make an over-scoped token something an operator has
 * to lie about rather than something they can do by accident, which is how
 * over-scoped tokens are actually created.
 */
import type { TenantClient } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';

/**
 * Refuses the call when the credential does not cover what the capability
 * needs.
 *
 * Both lists are read in one query rather than two, so the answer cannot be
 * assembled from a credential and a capability observed at different moments.
 * A capability that needs nothing is the common case and returns immediately.
 */
export async function assertScopesCover(
  tx: TenantClient,
  divisionId: string,
  alias: string,
  capabilityName: string,
): Promise<void> {
  const { rows } = await tx.query<{ required: string[]; held: string[] | null }>(
    `SELECT c.required_scopes AS required,
            (SELECT cr.scopes FROM credentials cr
              WHERE cr.division_id = $1 AND cr.alias = $2) AS held
       FROM capabilities c WHERE c.name = $3`,
    [divisionId, alias, capabilityName],
  );

  const row = rows[0];
  // No row means the capability is not in the catalogue, which the broker has
  // already refused before reaching an adapter. Nothing to add here.
  if (!row || row.required.length === 0) return;

  // `held` is null when the division has no such alias. `resolveCurrent` is
  // about to say so with the code the caller's contract promises, so this
  // stays out of its way rather than inventing a second answer to one question.
  if (row.held === null) return;

  const missing = row.required.filter((scope) => !row.held!.includes(scope));
  if (missing.length > 0) {
    throw new PalugadaError(
      'credential.scope_insufficient',
      `${capabilityName} needs ${missing.join(', ')} and the credential ${alias} ` +
        'does not declare it; issue a token with that scope rather than widening ' +
        'this one past what its division needs (PRD F12.6)',
      { capability: capabilityName, alias, missing },
    );
  }
}
