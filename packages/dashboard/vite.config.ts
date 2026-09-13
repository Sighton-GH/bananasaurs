import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Bound to the same loopback origin the daemon serves from — `server.ts`
 * mounts this build's `dist/` and falls back to `index.html` for the SPA
 * routes (`docs/19` §6.10). `npm run dev` in the daemon does not proxy to
 * Vite's dev server; a change here still needs `vite build` to reach the
 * dashboard the daemon actually serves.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
