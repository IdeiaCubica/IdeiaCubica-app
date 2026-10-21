/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, open: true },
  // Pacote único (~400 KB, ~126 KB compactado) é aceitável para um sistema interno.
  build: { chunkSizeWarningLimit: 700 },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
