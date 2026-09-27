import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The console is served by the owner API from `dist/`, under a content
// security policy that allows scripts and styles from its own origin only.
// So: one origin, relative asset paths, no inline scripts, no CDN.
export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // Mantine and the charts are large by design and cached across releases.
    chunkSizeWarningLimit: 700,
    // Mantine and React are one vendor chunk the browser caches across
    // releases of the page itself.
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          // pdf.js is loaded only when the owner chooses a PDF (src/pdf.ts),
          // so it stays with the import that asks for it. In the vendor
          // chunk every page would carry it; in a chunk named here, the
          // bundler puts shared helpers in it and the page loads it anyway.
          if (/pdfjs-dist/.test(id)) return undefined;
          // The same for the charts, which only Overview and Money draw and
          // which arrive with them (App.tsx loads both lazily). Named, they
          // were a chunk the vendor chunk imported from, and every page --
          // the sign-in page too -- fetched 135 KB of charts to use none.
          //
          // So only what every page is built from is pinned into the vendor
          // chunk; anything else -- the charts and all they bring, lodash
          // among it -- goes where the pages that use it are.
          return /[\\/]node_modules[\\/](react|react-dom|scheduler|@mantine[\\/](core|hooks|notifications|spotlight)|@tabler[\\/]icons-react|@floating-ui|@fontsource-variable)[\\/]/.test(id)
            ? 'vendor' : undefined;
        },
      },
    },
  },
  server: {
    // `npm run dev` against a running deployment on :8787.
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
});
