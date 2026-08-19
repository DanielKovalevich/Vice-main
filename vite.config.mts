import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react-swc';

// share.py serves UI assets through _resolve_ui_asset, which rejects any name
// containing a path separator and only knows the fonts/styles/scripts kinds.
// So the build has to emit exactly two flat, unhashed files. No code
// splitting, no hashed chunks, no emitted sub-assets.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'vice/ui',
    // fonts/ and index.html live here already and are not ours to delete.
    emptyOutDir: false,
    target: 'es2020',
    cssCodeSplit: false,
    sourcemap: false,
    rollupOptions: {
      input: 'ui-src/main.tsx',
      output: {
        codeSplitting: false,
        entryFileNames: 'scripts/app.js',
        assetFileNames: 'styles/app.css',
      },
    },
  },
});
