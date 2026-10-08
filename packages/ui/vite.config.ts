import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [preact()],
  base: './',
  clearScreen: false,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // §10.5: the oldest engines sharing this build are Safari 16 (WKWebView) and WebKitGTK 2.40.
    target: ['safari16', 'chrome110'],
  },
});
