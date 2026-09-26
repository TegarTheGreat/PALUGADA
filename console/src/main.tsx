import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider, createTheme } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import '@mantine/core/styles.css';
import '@mantine/charts/styles.css';
import '@mantine/notifications/styles.css';
import './app.css';
import { App } from './App.tsx';
import { FactorProvider } from './factor.tsx';

const theme = createTheme({
  primaryColor: 'blue',
  defaultRadius: 'md',
  cursorType: 'pointer',
  headings: { fontWeight: '800' },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <Notifications position="top-right" />
      <FactorProvider>
        <App />
      </FactorProvider>
    </MantineProvider>
  </StrictMode>,
);
