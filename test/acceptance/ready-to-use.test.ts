/**
 * Ready to use: the installation an owner meets before any company exists.
 *
 * `npm run setup` asks where PALUGADA runs, enrols the owner's authenticator
 * and chooses the model, checking each while the operator is still there, and
 * writes the answers where `npm start` reads them. These drive it the way a
 * person at a terminal would, against a model server the test controls.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { setup, writeEnvFile, type SetupIo } from '../../scripts/setup.ts';
import { qrForTerminal, qrMatrix } from '../../src/owner/qr.ts';
import { decodeBase32, stepFor, totpCode } from '../../src/owner/mfa.ts';
import { modelSettingsFrom } from '../../src/llm/models.ts';
import { LocalSecretManager } from '../../src/secrets/local.ts';

const servers: Server[] = [];
after(() => { for (const server of servers) server.close(); });

/** A Chat Completions server that calls the tool it is offered, or only talks. */
async function modelServer(callsTools: boolean): Promise<string> {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: 'served',
        choices: [{
          finish_reason: callsTools ? 'tool_calls' : 'stop',
          message: callsTools
            ? { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ping', arguments: '{}' } }] }
            : { content: 'pong' },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

/** A person at the terminal: answers by what is asked, and remembers what was shown. */
function person(answer: (question: string, shown: string) => string): SetupIo & { asked: string[]; shown: string[] } {
  const asked: string[] = [];
  const shown: string[] = [];
  return {
    asked,
    shown,
    terminal: false,
    say: (text) => { shown.push(text); },
    ask: async (question) => {
      asked.push(question);
      return answer(question, shown.join('\n'));
    },
  };
}

const keyShown = (shown: string) => /into it: ([A-Z2-7 ]+)/.exec(shown)![1]!.replace(/ /g, '');
const codeFor = (key: string) => totpCode(decodeBase32(key), stepFor());

test('a first installation on this machine: the owner\'s factor checked, a local model checked, one file written', async () => {
  const url = await modelServer(true);
  const envPath = join(mkdtempSync(join(tmpdir(), 'palugada-setup-')), '.env');
  const io = person((question, shown) => {
    if (question.startsWith('Choose')) return /Which model/.test(shown.split('\n').slice(-8).join('\n')) ? '5' : '1';
    if (question.startsWith('The six-digit code')) return codeFor(keyShown(shown));
    if (question.startsWith('Its address')) return url;
    if (question.startsWith('The model every role runs on')) return 'qwen3:8b';
    throw new Error(`not expected: ${question}`);
  });
  await setup(io, { envPath, probeDatabase: async () => false });

  const written = parseEnv(readFileSync(envPath, 'utf8'));
  assert.equal(statSync(envPath).mode & 0o777, 0o600, 'it holds the second factor: its owner reads it, nobody else');
  assert.ok(io.shown.some((line) => line === 'That is the right code.'));
  assert.ok(io.shown.some((line) => /called the tool it was offered/.test(line)), io.shown.join('\n'));
  const settings = modelSettingsFrom(written)!;
  assert.deepEqual([settings.provider, settings.url, settings.aliases.standard], ['openai', url, 'qwen3:8b']);
  assert.equal(written.PALUGADA_MODEL_KEY_REF, undefined, 'a model on this machine takes no key');
  const secret = await new LocalSecretManager({ env: written }).resolve(written.PALUGADA_OWNER_TOTP_REF!);
  assert.equal(secret, keyShown(io.shown.join('\n')), 'the factor the app was given is the one the deployment reads');
  assert.equal(written.PALUGADA_DB_APP_PASSWORD, undefined, 'the database here is the one db:setup makes');
  const urls = ['APP', 'ADMIN', 'OWNER'].map((role) => written[`PALUGADA_${role}_URL`] ?? '');
  urls.forEach((url, i) => assert.match(url, new RegExp(`^postgres://palugada_${['app', 'admin', 'owner'][i]}:[0-9a-f]{36}@127\\.0\\.0\\.1:5432/palugada$`)));
  assert.equal(new Set(urls.map((url) => url.split(':')[2])).size, 3, 'no development password, and each role its own');

  // Run again: nothing is asked but whether to change the model, and nothing changes.
  const before = readFileSync(envPath, 'utf8');
  const again = person(() => '');
  await setup(again, { envPath, probeDatabase: async () => { throw new Error('the database is already settled'); } });
  assert.equal(again.asked.length, 1, again.asked.join(' | '));
  assert.ok(again.asked[0]!.startsWith(`The model is openai at ${url}, standard = qwen3:8b. Change it?`), again.asked[0]);
  assert.equal(readFileSync(envPath, 'utf8'), before);
});

test('with Docker Compose: passwords made for the database, a model that only talks is named for what it is', async () => {
  const url = await modelServer(false);
  const envPath = join(mkdtempSync(join(tmpdir(), 'palugada-setup-')), '.env');
  let codes = 0;
  const io = person((question, shown) => {
    if (question.startsWith('Choose')) return /Which model/.test(shown.split('\n').slice(-8).join('\n')) ? '6' : '2';
    if (question.startsWith('The six-digit code')) return codes++ === 0 ? 'wrong!' : '';
    if (question.startsWith('Its address')) return url;
    if (question.startsWith('Its API key')) return 'sk-a-key-0123456789';
    if (question.startsWith('The model every role runs on')) return 'small-model';
    if (question.startsWith('Keep these settings anyway')) return 'y';
    throw new Error(`not expected: ${question}`);
  });
  await setup(io, { envPath });

  const written = parseEnv(readFileSync(envPath, 'utf8'));
  const passwords = ['SUPERUSER', 'OWNER', 'APP', 'ADMIN'].map((role) => written[`PALUGADA_DB_${role}_PASSWORD`]);
  assert.ok(passwords.every((password) => /^[0-9a-f]{36}$/.test(password ?? '')), JSON.stringify(passwords));
  assert.equal(new Set(passwords).size, 4, 'each role its own password');
  assert.ok(io.shown.some((line) => /does not match this key/.test(line)), 'a wrong code is caught while the operator is there');
  assert.ok(io.shown.some((line) => /did not call the tool .* can only answer in words/.test(line)), io.shown.join('\n'));
  assert.equal(written.PALUGADA_SECRET_MODEL_KEY, 'sk-a-key-0123456789');
  assert.equal(written.PALUGADA_MODEL_KEY_REF, 'env://PALUGADA_SECRET_MODEL_KEY');
  assert.ok(io.shown.some((line) => /docker compose up/.test(line)));
});

test('the file is edited in place: comments and order kept, a removed setting gone, JSON quoted', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'palugada-setup-')), '.env');
  const original = '# mine\nPALUGADA_PORT=9000\nPALUGADA_MODEL=old\nexport PALUGADA_MODEL_URL=http://x/v1\n';
  writeEnvFile(path, original, {
    PALUGADA_MODEL: 'new', PALUGADA_MODEL_URL: null, PALUGADA_MODEL_ALIASES: '{"deep":"big"}',
  });
  const text = readFileSync(path, 'utf8');
  assert.match(text, /^# mine\nPALUGADA_PORT=9000\nPALUGADA_MODEL=new\n\n# Written by npm run setup/);
  assert.doesNotMatch(text, /MODEL_URL/);
  assert.deepEqual(parseEnv(text).PALUGADA_MODEL_ALIASES, '{"deep":"big"}');
});

test('the QR code for an authenticator is the one an independent encoder draws', () => {
  // python-qrcode 8, version 7, level M, the mask this encoder chose; the
  // same bytes a phone reads. Checked against a decoder when it was written.
  const uri = 'otpauth://totp/PALUGADA:owner?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=PALUGADA&algorithm=SHA1&digits=6&period=30';
  const expected = [
  '#######..##...#...##.#...#....#.....#.#######',
  '#.....#..#.#...###.######........#.#..#.....#',
  '#.###.#.##.###...#.......#....####.#..#.###.#',
  '#.###.#.##..#..#.####....#....##...##.#.###.#',
  '#.###.#.#.##.#.###.#######..###...###.#.###.#',
  '#.....#.##.###.##.#.#...####..##.#....#.....#',
  '#######.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#######',
  '........#..#.#.######...##.#..###.###........',
  '#.#####.....###...#.#######....#..#...#####..',
  '##...#..#..##..#####...#.#....##.#.###...####',
  '#...#.#.##......#.#..##.#....#.#.##..##..###.',
  '..#.#....##....#...##...#..##.##.#.###.#.####',
  '.#.#####..#..##.#.#.#####....#.#..###......##',
  '....##..##.####..#.##.#..#.#..#....##...#...#',
  '#######...###...###.#...##.#.#.#.....###..##.',
  '..###..##.#...#.#.##.#.###...#.####.#....##..',
  '..#####.###.#.##.####.#.###..#.#.........###.',
  '####.#.#.....##..###..#.##.#.##.....##..#....',
  '..###.#.####.###..###.###...####..#..#.#..##.',
  '##..#......#.##.#...........#####.....#.####.',
  '.#.########......########.##.###.#..#####..#.',
  '#####...#####...#...#...##..####...##...###.#',
  '....#.#.##....####..#.#.#.###.#.###.#.#.#.##.',
  '.####...#...##..#..##...#....#..#.#.#...#####',
  '.##.#########.##.#..######...###..########...',
  '##.##..##.##.###..###.#..#.#.###....#.....#.#',
  '##.#..#.##...#...##..#.#....####..#.##...#.#.',
  '##..#..#.###.#.#..###.#.#.#.##.....##....####',
  '##....#.###....##.##...##....###..#.##..##.#.',
  '#.#.##.#....###.##......##.##.###...#.....###',
  '.###.##.#.#.###...#..#...#...#......##....##.',
  '..#.....###....##.#....##..#..####....##.###.',
  '####..##.##...#.#......#.#....##..#.###...#.#',
  '##...#.....#..#...######.#...####..###...#...',
  '....#.###.#.#..#.#...#..#..#..###.##.#...###.',
  '.####....#.#...###..#.###.##....#####...#.#..',
  '#..##.##..##.##.##.#######....##....######...',
  '........#.##.####..##...##.#.####...#...#.###',
  '#######...#...###...#.#.#.##.###.##.#.#.#.##.',
  '#.....#.##..#.#.#.###...##.#..###...#...#####',
  '#.###.#.#.#.#.#.##..#####.....##.#.######..##',
  '#.###.#.##..###...####..##...####..#..#.#.###',
  '#.###.#.#..####..#.#..###..#..#..##.#..#...#.',
  '#.....#...#..#..#.#.#...#..###########..###..',
  '#######.#..#####.#.#..###..#........##.##..#.',
  ];
  assert.deepEqual(qrMatrix(uri).map((row) => row.map((dark) => (dark ? '#' : '.')).join('')), expected);

  // Drawn two rows to a character: the upper module is the foreground of a
  // half block, the lower its background, dark on light whatever the theme.
  const drawn = qrForTerminal(qrMatrix(uri)).split('\n').flatMap((line) => {
    const cells = [...line.matchAll(/\x1b\[(30|97);(40|107)m\u2580/g)];
    return [cells.map((cell) => (cell[1] === '30' ? '#' : '.')).join(''), cells.map((cell) => (cell[2] === '40' ? '#' : '.')).join('')];
  });
  const quiet = '.'.repeat(expected.length + 4);
  assert.deepEqual(drawn.slice(0, expected.length + 4),
    [quiet, quiet, ...expected.map((row) => `..${row}..`), quiet, quiet]);
  assert.equal(qrMatrix('x'.repeat(1000)).length, 4 * 26 + 17, 'a longer text takes a larger symbol');
  assert.throws(() => qrMatrix('x'.repeat(3000)), /do not fit/);
});
