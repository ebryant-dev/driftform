import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Two pages: the standalone experience (index.html) and a dev-only embed
// test bed (embed.html) that mimics a site hero with copy over the canvas.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        embed: resolve(import.meta.dirname, 'embed.html'),
      },
    },
  },
});
