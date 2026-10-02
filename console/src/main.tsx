import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  DirectionProvider, MantineProvider, createTheme, type MantineColorScheme, type MantineColorSchemeManager, type MantineColorsTuple,
} from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import '@fontsource-variable/inter';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import '@mantine/spotlight/styles.css';
import './app.css';
import { App } from './App.tsx';
import { FactorProvider } from './factor.tsx';
import { direction, locale } from './i18n.ts';

/** One colour for the product, an indigo: calm enough for money, distinct from every status colour. */
const brand: MantineColorsTuple = [
  '#eef2ff', '#e0e7ff', '#c7d2fe', '#a5b4fc', '#818cf8', '#6366f1', '#4f46e5', '#4338ca', '#3730a3', '#312e81',
];

/**
 * Inter for Latin and Cyrillic, then each platform's own face for the scripts
 * Inter lacks, named rather than left to the browser: a machine whose first
 * Han font is a Japanese one draws Chinese with Japanese glyph shapes, and
 * the page's `lang` (set from the locale, `zh-CN`) is only a hint.
 */
const FONTS = [
  "'Inter Variable'", 'system-ui', '-apple-system', "'Segoe UI'", 'Roboto',
  "'PingFang SC'", "'Microsoft YaHei'", "'Noto Sans SC'", "'Noto Sans CJK SC'",
  "'Noto Sans Devanagari'", "'Nirmala UI'", "'Kohinoor Devanagari'",
  'sans-serif',
].join(', ');

const theme = createTheme({
  primaryColor: 'brand',
  colors: { brand },
  primaryShade: { light: 6, dark: 5 },
  defaultRadius: 'md',
  cursorType: 'pointer',
  fontFamily: FONTS,
  headings: { fontFamily: FONTS, fontWeight: '750' },
});

/**
 * The colour scheme, kept for the life of the tab and nowhere else.
 *
 * Mantine's default manager writes it to localStorage, and the console stores
 * nothing in the browser. "Auto" follows the device, which is what most owners
 * want; a choice made from the menu lasts until the tab is closed.
 */
function memoryColorSchemeManager(): MantineColorSchemeManager {
  let chosen: MantineColorScheme | null = null;
  return {
    get: (fallback) => chosen ?? fallback,
    set: (value) => { chosen = value; },
    subscribe: () => undefined,
    unsubscribe: () => undefined,
    clear: () => { chosen = null; },
  };
}

document.documentElement.lang = locale();
document.documentElement.dir = direction();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DirectionProvider initialDirection={direction()} detectDirection={false}>
      <MantineProvider theme={theme} defaultColorScheme="auto" colorSchemeManager={memoryColorSchemeManager()}>
        <Notifications position="top-right" />
        <FactorProvider>
          <App />
        </FactorProvider>
      </MantineProvider>
    </DirectionProvider>
  </StrictMode>,
);
