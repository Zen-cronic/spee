import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

// The web build of the Speaking Mirror. react-native-web stands in for react-native, so the views
// use RN primitives only and sync verbatim into the Vega app (npm run tv:sync).
// Served by the hub at /tv/ (npm run tv:web:build); `npm run tv:web:dev` proxies to the hub on 8791.
export default defineConfig({
  base: '/tv/',
  plugins: [react()],
  resolve: {
    alias: { 'react-native': 'react-native-web' },
    conditions: ['source', ...defaultClientConditions],
    extensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.mjs', '.js', '.json'],
  },
  define: { __DEV__: JSON.stringify(process.env.NODE_ENV !== 'production'), global: 'globalThis' },
  server: {
    port: 5183,
    strictPort: true,
    proxy: { '/ws': { target: 'ws://localhost:8791', ws: true }, '/api': 'http://localhost:8791' },
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
