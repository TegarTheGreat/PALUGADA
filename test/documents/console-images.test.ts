/**
 * The console draws pictures, never initials, and every picture it names ships with it.
 *
 * Companies and roles were drawn as their first letter or two: "K" for Kopi
 * and "K" for Kain, "CO" for the coordinator, a gradient "P" for PALUGADA
 * itself. A letter says nothing the name beside it does not, and two
 * companies that start with the same one look the same. They are drawn from
 * images made for PALUGADA now (brand/README.md says how), served from the
 * console's own origin so the content security policy lets them load. A path
 * that names a file nobody shipped is a broken image the owner sees before
 * any test does, so the paths are checked against the files.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPANY_EMBLEMS, companyEmblem, OWNER_PICTURE, rolePicture, ROLE_PICTURES } from '../../console/src/images.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CONSOLE = join(ROOT, 'console');
const PUBLIC = join(CONSOLE, 'public');
const BRAND = join(ROOT, 'brand');

async function sources(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path, `${prefix}${entry.name}/`);
      else if (/\.(ts|tsx)$/.test(entry.name)) files.set(`${prefix}${entry.name}`, await readFile(path, 'utf8'));
    }
  };
  await walk(join(CONSOLE, 'src'), '');
  return files;
}

const shipped = async (path: string) => stat(join(PUBLIC, path)).then((found) => found.isFile(), () => false);

/** Width and height from a PNG's header, which is all a size check needs. */
async function pngSize(path: string): Promise<[number, number]> {
  const bytes = await readFile(path);
  assert.equal(bytes.subarray(1, 4).toString('latin1'), 'PNG', `${path} is not a PNG`);
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

test('no company, role or owner is drawn from the letters of a name', async () => {
  const files = await sources();
  assert.ok(files.size > 10, `only ${files.size} source files were found; the scan is broken`);
  const found: string[] = [];
  for (const [path, source] of files) {
    // Every avatar is a picture: it names its image and has nothing inside it.
    for (const match of source.matchAll(/<Avatar\b[^>]*?(\/?)>/gs)) {
      const line = source.slice(0, match.index).split('\n').length;
      if (!/\bsrc=/.test(match[0])) found.push(`${path}:${line} an Avatar with no picture`);
      if (match[1] !== '/') found.push(`${path}:${line} an Avatar with something written inside it`);
    }
    for (const match of source.matchAll(/\b(?:name|slug|title|label|device)\??\.(?:slice\(0,\s*[12]\)|charAt\(0\)|at\(0\)|substring\(0,\s*[12]\))/g)) {
      found.push(`${path}:${source.slice(0, match.index).split('\n').length} the first letters of a name: ${match[0]}`);
    }
    for (const match of source.matchAll(/brand-mark[^>]*>\s*[A-Za-z]{1,2}\s*</g)) {
      found.push(`${path}:${source.slice(0, match.index).split('\n').length} the brand as a letter: ${match[0]}`);
    }
  }
  assert.deepEqual(found, []);
});

test('a company is drawn as what its name says it sells, and otherwise by its id, spread evenly', async () => {
  for (const emblem of COMPANY_EMBLEMS) assert.ok(await shipped(`avatars/companies/${emblem}.webp`), `${emblem} is not shipped`);
  const drawn = (name: string, id = '00000000-0000-4000-8000-000000000001') =>
    companyEmblem({ id, name }).replace(/^\/avatars\/companies\/|\.webp$/g, '');
  // In Indonesian or English, by whole words, in order.
  assert.deepEqual(
    ['Kopi Nusantara', 'Toko Sari', 'Batik Kain Jaya', 'Lumen Studio', 'Tani Makmur', 'Kursus Bahasa Kita', 'Martabak Manis'].map((name) => drawn(name)),
    ['coffee', 'shop', 'bag', 'rocket', 'sprout', 'book', 'coffee'],
  );
  assert.equal(drawn('Tasty Lestari'), drawn('Acme'), 'a word is matched whole: "tasty" is not a bag (tas), "lestari" not a lesson (les)');

  // A name that says nothing: the id decides, so a rename keeps the emblem.
  const counts = new Map<string, number>();
  for (let n = 0; n < 1200; n += 1) {
    const id = `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
    const picture = drawn('Acme', id);
    assert.equal(drawn('Zenith Holdings', id), picture, 'renamed, it keeps its emblem');
    counts.set(picture, (counts.get(picture) ?? 0) + 1);
  }
  assert.equal(counts.size, COMPANY_EMBLEMS.length, 'every emblem is used');
  for (const [picture, count] of counts) {
    assert.ok(count > 50 && count < 150, `${picture} was given to ${count} of 1200 companies; the spread is uneven`);
  }
});

test('a role is drawn doing its job when its name says what that is, and as an agent when it does not', async () => {
  for (const picture of ROLE_PICTURES) assert.ok(await shipped(`avatars/roles/${picture}.webp`), `${picture} is not shipped`);
  const drawn = (slug: string) => rolePicture(slug).replace(/^\/avatars\/roles\/|\.webp$/g, '');
  // The roles the templates and bundles hire, and the kind of names an owner gives.
  assert.deepEqual(
    ['coordinator', 'planner', 'builder', 'marketer', 'bookkeeper', 'responder', 'reviewer', 'analyst',
      'strategist', 'researcher', 'writer', 'web-operator', 'qa-reviewer', 'platform-engineer', 'platform-reviewer',
      'content-writer', 'field-sales', 'copywriter', 'customer-support', 'ux-designer', 'growth-lead'].map(drawn),
    ['coordinator', 'planner', 'builder', 'marketer', 'bookkeeper', 'responder', 'reviewer', 'analyst',
      'strategist', 'researcher', 'writer', 'web', 'reviewer', 'engineer', 'reviewer',
      'writer', 'sales', 'writer', 'responder', 'designer', 'marketer'],
  );
  // A name that says nothing gets an agent, and always the same one.
  const plain = ['worker', 'kopi-a', 'lumen', 'x'].map(drawn);
  for (const picture of plain) assert.match(picture, /^agent(-\w+)?$/);
  assert.deepEqual(['worker', 'kopi-a', 'lumen', 'x'].map(drawn), plain);
  assert.ok(await shipped(OWNER_PICTURE.slice(1)), 'the owner has a picture');
});

test('every image path the console names is a file it ships', async () => {
  const named = new Set<string>();
  for (const source of (await sources()).values()) {
    for (const match of source.matchAll(/['"`]\/((?:avatars|brand|illustrations)\/[\w./-]+\.(?:webp|png|svg))['"`]/g)) named.add(match[1]!);
  }
  assert.ok(named.size >= 4, `only ${named.size} images were found; the scan is broken`);
  for (const path of named) assert.ok(await shipped(path), `/${path} is named and not shipped`);
});

test('the page names its icons and its manifest, and each is the size it says', async () => {
  const html = await readFile(join(CONSOLE, 'index.html'), 'utf8');
  const links = [...html.matchAll(/<link rel="([\w -]+)" href="\/([^"]+)"/g)].map((match) => [match[1]!, match[2]!] as const);
  const rels = links.map(([rel]) => rel);
  for (const wanted of ['icon', 'apple-touch-icon', 'manifest']) assert.ok(rels.includes(wanted), `no <link rel="${wanted}">`);
  for (const [, path] of links) assert.ok(await shipped(path), `/${path} is linked and not shipped`);
  assert.equal(await pngSize(join(PUBLIC, 'apple-touch-icon.png')).then(([w]) => w), 180);

  const manifest = JSON.parse(await readFile(join(PUBLIC, 'manifest.webmanifest'), 'utf8')) as {
    name: string; icons: { src: string; sizes: string; type: string; purpose?: string }[];
  };
  assert.equal(manifest.name, 'PALUGADA');
  assert.ok(manifest.icons.some((icon) => icon.purpose === 'maskable'), 'an icon Android may crop to its own shape');
  for (const icon of manifest.icons) {
    assert.ok(await shipped(icon.src.slice(1)), `${icon.src} is in the manifest and not shipped`);
    if (icon.type === 'image/png') {
      const [width, height] = await pngSize(join(PUBLIC, icon.src.slice(1)));
      assert.equal(`${width}x${height}`, icon.sizes, `${icon.src} says ${icon.sizes}`);
    }
  }
});

test('the brand kit is outlined vectors and PNGs of the sizes their names give', async () => {
  const readme = await readFile(join(BRAND, 'README.md'), 'utf8');
  const svgs = (await readdir(join(BRAND, 'svg'))).filter((name) => name.endsWith('.svg'));
  assert.ok(svgs.length >= 20, `only ${svgs.length} vectors`);
  for (const name of svgs) {
    const svg = await readFile(join(BRAND, 'svg', name), 'utf8');
    assert.match(svg, /^<svg [^>]*viewBox="0 0 [\d.]+ [\d.]+"/, `${name} has no viewBox`);
    // Letters as paths, so the wordmark does not depend on a font being there;
    // nothing fetched; none of the generator's provenance blob, which is most of the file.
    assert.doesNotMatch(svg, /<text\b|<metadata\b|c2pa|xlink:href="http|href="http/, `${name} carries text, metadata or a remote reference`);
    assert.ok(readme.includes(name), `${name} is not described in brand/README.md`);
  }
  const pngs = (await readdir(join(BRAND, 'png'))).filter((name) => name.endsWith('.png'));
  assert.ok(pngs.length >= 40, `only ${pngs.length} PNGs`);
  for (const name of pngs) {
    const [width, height] = await pngSize(join(BRAND, 'png', name));
    const square = name.match(/-(\d+)\.png$/);
    const wide = name.match(/-(\d+)w\.png$/);
    if (square) assert.deepEqual([width, height], [Number(square[1]), Number(square[1])], name);
    else if (wide) assert.equal(width, Number(wide[1]), name);
    else assert.fail(`${name} does not say its size`);
  }
  for (const [name, size] of [['palugada-og.png', [1200, 630]], ['palugada-social-preview.png', [1280, 640]], ['palugada-banner-dark.png', [1280, 320]]] as const) {
    assert.deepEqual(await pngSize(join(BRAND, 'banners', name)), [...size], name);
  }
});
