import { z } from 'zod';

const Env = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  PAGESPEED_API_KEY: z.string().min(10),
  PUBLIC_SITE_URL: z.string().url(),
  CHROMIUM_PATH: z.string().optional(),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(2).default(2),
  SENTRY_DSN: z.string().url().optional(),
});
export type Env = z.infer<typeof Env>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = Env.safeParse(source);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Worker configuration invalid or missing: ${missing}. See .env.example.`);
  }
  return parsed.data;
}
