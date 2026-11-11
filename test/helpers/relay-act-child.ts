/**
 * A replica that takes one envelope from a relay and is stopped in the
 * middle of it (F19.20; STATUS section 2.216). The test that forks it holds
 * a lock the act waits for, kills this process while it waits, and then
 * sees what a relay sending the same envelope again is answered.
 *
 *   node test/helpers/relay-act-child.ts <relay id> <envelope as JSON>
 */
import { receiveFromRelay } from '../../src/relay/inbound.ts';

const [relayId, envelope] = [process.argv[2] ?? '', JSON.parse(process.argv[3] ?? '{}') as Parameters<typeof receiveFromRelay>[1]];
process.send?.('started');
await receiveFromRelay(relayId, envelope);
process.exit(0);
