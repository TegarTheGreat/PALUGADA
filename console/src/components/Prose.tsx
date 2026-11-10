/**
 * What an agent wrote, shown as it was meant: headings, lists, bold, tables.
 *
 * `parseMarkdown` (console/src/markdown.ts) turns the text into a tree; this
 * draws the tree with the console's own components. No markup is ever built
 * from the text, so there is nothing in it to run, and a link goes out only
 * through `safeAddress` and opens in a new tab that is told nothing of this
 * one. The text itself is never altered: it is what the agent wrote, and what
 * the agent wrote is data.
 */
import type { ReactNode } from 'react';
import { Anchor, Blockquote, Code, Divider, List, Table, Text, Title } from '@mantine/core';
import type { MantineSize } from '@mantine/core';
import { parseMarkdown, safeAddress } from '../markdown.ts';
import type { Block, Inline, Item } from '../markdown.ts';

/** A long address or an unbroken word wraps rather than widen the screen. */
const WRAPS = { overflowWrap: 'anywhere' } as const;

function inline(spans: Inline[]): ReactNode[] {
  return spans.map((span, index) => {
    switch (span.t) {
      case 'text': return span.v;
      case 'br': return <br key={index} />;
      case 'strong': return <strong key={index}>{inline(span.c)}</strong>;
      case 'em': return <em key={index}>{inline(span.c)}</em>;
      case 'code': return <Code key={index}>{span.v}</Code>;
      case 'link': {
        // A second look: the parser has already refused any other address,
        // and the page does not rely on that alone.
        const address = safeAddress(span.href);
        return address
          ? <Anchor key={index} href={address} target="_blank" rel="noopener noreferrer" style={WRAPS}>{inline(span.c)}</Anchor>
          : <span key={index}>{inline(span.c)}</span>;
      }
    }
  });
}

function items(list: Item[], size: MantineSize): ReactNode[] {
  return list.map((item, index) => (
    <List.Item key={index} styles={{ itemLabel: { display: 'block' } }}>
      <span style={WRAPS}>{inline(item.c)}</span>
      {item.sub && block(item.sub, 0, size)}
    </List.Item>
  ));
}

function block(one: Block, index: number, size: MantineSize): ReactNode {
  switch (one.t) {
    case 'p': return <Text key={index} size={size} style={WRAPS}>{inline(one.c)}</Text>;
    case 'h': return (
      <Title key={index} order={Math.min(one.level + 2, 6) as 3 | 4 | 5 | 6} size={one.level <= 2 ? 'h4' : 'h5'} style={WRAPS}>
        {inline(one.c)}
      </Title>
    );
    case 'ul': return <List key={index} size={size} withPadding>{items(one.items, size)}</List>;
    case 'ol': return <List key={index} size={size} type="ordered" start={one.start} withPadding>{items(one.items, size)}</List>;
    case 'quote': return <Blockquote key={index} p="xs" mt={0}>{one.c.map((inner, at) => block(inner, at, size))}</Blockquote>;
    case 'pre': return <Code key={index} block style={{ whiteSpace: 'pre-wrap', ...WRAPS }}>{one.v}</Code>;
    case 'hr': return <Divider key={index} />;
    case 'table': return (
      <Table.ScrollContainer key={index} minWidth={0}>
        <Table withTableBorder withColumnBorders fz={size}>
          <Table.Thead>
            <Table.Tr>{one.head.map((cell, at) => <Table.Th key={at}>{inline(cell)}</Table.Th>)}</Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {one.rows.map((row, at) => (
              <Table.Tr key={at}>{row.map((cell, column) => <Table.Td key={column}>{inline(cell)}</Table.Td>)}</Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    );
  }
}

export function Prose({ text, size = 'sm' }: { text: string; size?: MantineSize }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
      {parseMarkdown(text).map((one, index) => block(one, index, size))}
    </div>
  );
}
