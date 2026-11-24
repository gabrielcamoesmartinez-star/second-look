import { defineConfig } from 'tsup';
// Bundles the workspace shared package into the worker; npm dependencies stay external.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  splitting: false,
  noExternal: ['@second-look/shared'],
});
