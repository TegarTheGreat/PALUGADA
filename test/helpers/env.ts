/**
 * The names a child process was handed, less the one Node adds by itself.
 *
 * While the suite runs with coverage, Node puts `NODE_V8_COVERAGE` into the
 * environment of every process it spawns, whatever environment the parent
 * passed: lib/child_process.js does it on purpose, so that coverage survives
 * a scrubbed environment. It is the test runner's, never something the
 * orchestrator handed over, and the tests that hold a child to exactly the
 * names it was given would otherwise fail only when coverage is measured.
 */
export function handed(keys: string[]): string[] {
  return keys.filter((key) => key !== 'NODE_V8_COVERAGE');
}
