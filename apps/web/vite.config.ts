import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// Only these two PUBLIC values reach the browser. We deliberately do not use an
// envPrefix like "SUPABASE_", which would also expose SUPABASE_SERVICE_ROLE_KEY.
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, '../../', ''), ...process.env };
  return {
    plugins: [react()],
    envPrefix: '__NEVER__',
    define: {
      __SUPABASE_URL__: JSON.stringify(env['SUPABASE_URL'] ?? ''),
      __SUPABASE_ANON_KEY__: JSON.stringify(env['SUPABASE_ANON_KEY'] ?? ''),
      __AUDITS_PER_USER_PER_DAY__: JSON.stringify(Number(env['AUDITS_PER_USER_PER_DAY'] ?? '3')),
    },
    build: { sourcemap: true },
  };
});
