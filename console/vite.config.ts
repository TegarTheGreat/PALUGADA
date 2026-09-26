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
    // Mantine and the charts are one vendor chunk the browser caches across
    // releases of the page itself.
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          return /recharts|@mantine[\\/]charts|d3-|victory/.test(id) ? 'charts' : 'vendor';
        },
      },
    },
  },
  server: {
    // `npm run dev` against a running deployment on :8787.
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
});
