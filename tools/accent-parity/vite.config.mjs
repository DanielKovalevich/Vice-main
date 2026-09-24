// Bundles entry.ts so the runtime accent derivation can be run under Node and
// diffed against the generator. Driven by tools/verify-custom-accent.mjs, not
// by anything the app ships.
import {defineConfig} from 'vite';

export default defineConfig({
  build: {
    lib: {entry: new URL('./entry.ts', import.meta.url).pathname, formats: ['es'], fileName: 'parity'},
    outDir: process.env.VICE_PARITY_OUT ?? new URL('./out', import.meta.url).pathname,
    minify: false,
    emptyOutDir: false,
    target: 'node20',
  },
});
