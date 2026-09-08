import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@gullabs/flipbook-core': path.resolve(root, '../../packages/core/src'),
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(root, 'index.html'),
      },
    },
  },
  server: { port: 5174 },
  preview: { host: '127.0.0.1', port: 4174 },
});
