import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Mirrors tsconfig's "@/*" path so tests can import route handlers as the app does.
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./', import.meta.url)) } },
});
