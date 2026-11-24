import { configDefaults, defineConfig } from 'vitest/config';
// Unit tests only. Browser integration tests use vitest.integration.config.ts.
export default defineConfig({
  test: { environment: 'node', env: { NODE_ENV: 'test' }, exclude: [...configDefaults.exclude, 'test/integration/**'] },
});
