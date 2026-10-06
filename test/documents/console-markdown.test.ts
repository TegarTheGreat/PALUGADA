/**
 * What an agent writes is read as the page it meant to be (the owner's complaint
 * of 6 October: "hasil kerja acak acakan format teksnya gajelas").
 *
 * A model answers in Markdown -- a heading, a list, `**bold**`, a table -- and
 * the console showed every asterisk and pound sign as typed. The reader that
 * turns it into elements (`console/src/markdown.ts`) is held to two things: it
 * reads what models actually write, and it never lets what an agent wrote do
 * anything but be read. There is no HTML in it to run, no image to fetch (an
 * image's address is a way to tell a stranger the page was opened), and a link
 * is followed only if it is http, https or mail.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseMarkdown, safeAddress, type Block, type Inline } from '../../console/src/markdown.ts';

const text = (inline: Inline[]): string => inline.map((one) => {
  if (one.t === 'text') return one.v;
  if (one.t === 'code') return one.v;
  if (one.t === 'br') return '\n';
  return text(one.c);
}).join('');

test('headings, paragraphs, lists, a quote, a rule and a fenced block are read as what they are', () => {
  const blocks = parseMarkdown([
    '# Weekly report',
    '',
    'Sales are **up** this week, *slightly*, and `ledger.read` agrees.',
    'A second line of the same paragraph.',
    '',
    '- first',
    '- second',
    '  - nested one',
    '  - nested two',
    '- third',
    '',
    '1. step one',
    '2. step two',
    '',
    '> Be careful with the **refund** policy.',
    '',
    '---',
    '',
    '```',
    'npm run check',
    '  # not a heading',
    '```',
  ].join('\n'));
  const kinds = blocks.map((block) => block.t);
  assert.deepEqual(kinds, ['h', 'p', 'ul', 'ol', 'quote', 'hr', 'pre']);
  assert.equal((blocks[0] as Extract<Block, { t: 'h' }>).level, 1);
  const paragraph = blocks[1] as Extract<Block, { t: 'p' }>;
  assert.deepEqual(paragraph.c.map((one) => one.t), ['text', 'strong', 'text', 'em', 'text', 'code', 'text', 'br', 'text']);
  const list = blocks[2] as Extract<Block, { t: 'ul' }>;
  assert.deepEqual(list.items.map((item) => text(item.c)), ['first', 'second', 'third']);
  assert.deepEqual((list.items[1]!.sub as Extract<Block, { t: 'ul' }>).items.map((item) => text(item.c)), ['nested one', 'nested two']);
  assert.equal((blocks[3] as Extract<Block, { t: 'ol' }>).items.length, 2);
  assert.equal((blocks[6] as Extract<Block, { t: 'pre' }>).v, 'npm run check\n  # not a heading');
});

test('a table is a table, with its alignment row not a row', () => {
  const [table] = parseMarkdown([
    '| Item | Qty | Price |',
    '|------|:---:|------:|',
    '| Beans | 10 | 90.000 |',
    '| Milk | 4 | 18.000 |',
  ].join('\n'));
  assert.equal(table!.t, 'table');
  const shown = table as Extract<Block, { t: 'table' }>;
  assert.deepEqual(shown.head.map(text), ['Item', 'Qty', 'Price']);
  assert.deepEqual(shown.rows.map((row) => row.map(text)), [['Beans', '10', '90.000'], ['Milk', '4', '18.000']]);
});

test('text that is not Markdown at all keeps its line breaks and loses nothing', () => {
  const plain = 'Dear Pak Budi,\nThe order shipped on 3 Oct.\n\nRegards';
  const blocks = parseMarkdown(plain);
  assert.deepEqual(blocks.map((block) => block.t), ['p', 'p']);
  assert.equal(text((blocks[0] as Extract<Block, { t: 'p' }>).c), 'Dear Pak Budi,\nThe order shipped on 3 Oct.');
  // Underscores inside words, a lone asterisk and a bare pound sign are words.
  const odd = parseMarkdown('snake_case_name costs 5 * 3 = 15 and #hashtag stays');
  assert.equal(text((odd[0] as Extract<Block, { t: 'p' }>).c), 'snake_case_name costs 5 * 3 = 15 and #hashtag stays');
  assert.equal(parseMarkdown('').length, 0);
});

test('a link is followed only if it is http, https or mail; an image is its words, never a fetch', () => {
  assert.equal(safeAddress('https://example.test/a?b=1'), 'https://example.test/a?b=1');
  assert.equal(safeAddress('mailto:owner@example.test'), 'mailto:owner@example.test');
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html;base64,AAAA', 'vbscript:x', '//evil.test', '/relative', 'file:///etc/passwd', ' javascript:alert(1)']) {
    assert.equal(safeAddress(bad), null, bad);
  }
  const [paragraph] = parseMarkdown('See [the invoice](https://example.test/inv/41), [a trap](javascript:alert(1)) and ![tracker](https://evil.test/pixel.png?id=7).');
  const inline = (paragraph as Extract<Block, { t: 'p' }>).c;
  const links = inline.filter((one): one is Extract<Inline, { t: 'link' }> => one.t === 'link');
  assert.deepEqual(links.map((link) => link.href), ['https://example.test/inv/41'], 'one link, and the other is only words');
  assert.ok(!JSON.stringify(inline).includes('pixel.png') || text(inline).includes('tracker'), 'the image is its alt text');
  assert.equal(inline.some((one) => (one as { t: string }).t === 'img'), false, 'no image element exists');
  assert.match(text(inline), /a trap/);
});

test('a hostile or enormous input is read, bounded, and never throws', () => {
  const nasty = ['*'.repeat(50_000), '['.repeat(20_000), '`'.repeat(30_000), '> '.repeat(10_000), '| a '.repeat(5_000) + '\n' + '|--'.repeat(5_000), '- '.repeat(10_000) + 'x', '  '.repeat(3_000) + '- deep'];
  for (const input of nasty) {
    const began = Date.now();
    const blocks = parseMarkdown(input);
    assert.ok(Array.isArray(blocks));
    assert.ok(Date.now() - began < 2_000, `read in ${Date.now() - began} ms`);
  }
});

test('the renderer has no way to run what it reads: no raw HTML, no image, links opened safely', async () => {
  const source = await readFile(new URL('../../console/src/components/Prose.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|innerHTML|<img|\bImage\b|eval\(/);
  assert.match(source, /rel="noopener noreferrer"/);
  assert.match(source, /target="_blank"/);
});
