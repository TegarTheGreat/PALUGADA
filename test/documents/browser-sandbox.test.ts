/**
 * The companies' browser in the image, with its sandbox (Dockerfile,
 * deploy/docker/seccomp-chromium.json, scripts/seccomp-chromium.ts).
 *
 * Under Docker's default seccomp profile Chromium cannot keep the pages it
 * renders apart, and will not start without `--no-sandbox`; the image runs
 * it with its sandbox under a profile that is Docker's own with one rule
 * added. These hold the pieces to each other: the profile is that and no
 * more, the image has Chromium, every compose file gives the container the
 * profile, and CI checks inside the image that a page renders sandboxed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROMIUM_RULE } from '../../scripts/seccomp-chromium.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

interface Rule {
  names: string[];
  action: string;
  includes?: { caps?: string[] };
  args?: unknown[];
}

test('the profile is Docker\'s own, with only what Chromium\'s sandbox needs added', () => {
  const profile = JSON.parse(read('deploy/docker/seccomp-chromium.json')) as { defaultAction: string; syscalls: Rule[] };
  assert.equal(profile.defaultAction, 'SCMP_ACT_ERRNO', 'what is not named is refused');
  const added = profile.syscalls.filter((rule) => (rule as { comment?: string }).comment?.startsWith('PALUGADA'));
  assert.deepEqual(added, [CHROMIUM_RULE], 'one rule is the platform\'s, and it is the last');
  assert.deepEqual(profile.syscalls.at(-1), CHROMIUM_RULE);
  // Docker's own rules are there: namespaces are otherwise CAP_SYS_ADMIN's,
  // and what no container should do stays refused to everyone without it.
  const docker = profile.syscalls.slice(0, -1);
  assert.ok(docker.some((rule) => rule.names.includes('clone') && rule.args && rule.args.length > 0), 'Docker\'s clone rule, by its flags');
  // (ptrace is Docker's to allow, on kernels since 4.8, and it does.)
  for (const name of ['mount', 'umount2', 'kexec_load', 'init_module', 'bpf', 'setns', 'pivot_root', 'reboot']) {
    const open = docker.filter((rule) => rule.action === 'SCMP_ACT_ALLOW' && rule.names.includes(name) && !rule.includes?.caps);
    assert.deepEqual(open, [], `${name} is allowed only with a capability no PALUGADA container has`);
  }
});

test('the image has Chromium, every compose file gives it the profile, and CI checks it renders sandboxed', () => {
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /^ARG PALUGADA_BROWSER=1$/m, 'Chromium is in the image unless left out');
  assert.match(dockerfile, /echo chromium fonts-liberation/);
  for (const [file, path] of [
    ['docker-compose.yml', './deploy/docker/seccomp-chromium.json'],
    ['deploy/coolify/docker-compose.yml', './deploy/docker/seccomp-chromium.json'],
    ['deploy/dokploy/docker-compose.yml', '../docker/seccomp-chromium.json'],
  ] as const) {
    assert.ok(read(file).includes(`      - seccomp=${path}\n`), `${file} gives the platform the profile`);
  }
  assert.match(read('.github/workflows/ci.yml'), /run: docker compose exec -T app node scripts\/browser-check\.ts/);
  // The check asks for the sandbox, not for a browser that started.
  assert.match(read('scripts/browser-check.ts'), /Cdp\.launch\(executable, \{ sandbox: true \}\)/);
});
