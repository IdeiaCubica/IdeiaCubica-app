/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, open: true },
  // Pacote único (~400 KB, ~126 KB compactado) é aceitável para um sistema interno.
  // Duas páginas: o sistema (index.html) e o catálogo público (catalogo.html, servido em /c/<link>).
  build: { chunkSizeWarningLimit: 700, rollupOptions: { input: { main: 'index.html', catalogo: 'catalogo.html' } } },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
