/**
 * Writes `deploy/docker/seccomp-chromium.json`: Docker's own seccomp
 * profile with one rule added, so the companies' browsers run with
 * Chromium's sandbox in the image (src/browser/cdp.ts).
 *
 * Chromium puts each page it renders in a user, PID and network namespace
 * of its own, and a page that breaks out of its renderer is then still in
 * them. Docker's default profile allows a process to make namespaces only
 * with CAP_SYS_ADMIN, which no container of the platform should have; so
 * under it Chromium has no sandbox and will not start without
 * `--no-sandbox` (seen in Docker 29 with Debian's Chromium 154, as the node
 * user). Debian's setuid helper (`chromium-sandbox`) fails the same way,
 * since even root in a container cannot make those namespaces without the
 * capability. This profile is Docker's, at a pinned commit, with `clone`
 * and `unshare` allowed to everyone in the container -- what the kernel
 * allows any unprivileged user outside one, and what a desktop's Chromium
 * relies on.
 *
 * Docker's profile is moby/profiles' `seccomp/default.json`, Apache-2.0.
 *
 *   node scripts/seccomp-chromium.ts           fetch it at the pinned commit and write the file
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** moby/profiles at the commit the file was made from, and what its profile hashed to. */
export const MOBY_COMMIT = '2ceae35d351c156cb5a8efc0fdc4a08cf94569d8';
const MOBY_SHA256 = '6416b47770785a41ac59073cdc77d9fe98517df2799dc83ef207e622de3053f6';

/** The one rule added: last, so it reads as the difference it is. */
export const CHROMIUM_RULE = {
  names: ['clone', 'unshare'],
  action: 'SCMP_ACT_ALLOW',
  comment: 'PALUGADA: Chromium puts each renderer in user, PID and network namespaces of its own (scripts/seccomp-chromium.ts)',
} as const;

export function withChromium(profile: { syscalls: unknown[] }): object {
  return { ...profile, syscalls: [...profile.syscalls, CHROMIUM_RULE] };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = `https://raw.githubusercontent.com/moby/profiles/${MOBY_COMMIT}/seccomp/default.json`;
  const text = await (await fetch(url)).text();
  const hash = createHash('sha256').update(text).digest('hex');
  if (hash !== MOBY_SHA256) {
    console.error(`${url} hashed to ${hash}, not ${MOBY_SHA256}: refusing to write a profile from it`);
    process.exit(1);
  }
  const target = fileURLToPath(new URL('../deploy/docker/seccomp-chromium.json', import.meta.url));
  writeFileSync(target, `${JSON.stringify(withChromium(JSON.parse(text) as { syscalls: unknown[] }), null, 2)}\n`);
  console.log(`wrote ${target} from moby/profiles ${MOBY_COMMIT.slice(0, 12)}`);
}
