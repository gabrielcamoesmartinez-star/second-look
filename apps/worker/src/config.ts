import { z } from 'zod';

const Env = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  PAGESPEED_API_KEY: z.string().min(10),
  WORKER_ID: z.string().default(`worker-${process.pid}`),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(2),
  POLL_INTERVAL_MS: z.coerce.number().int().min(250).default(2000),
  BOT_INFO_URL: z.string().url().default('https://secondlook.example/bot'),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Worker configuration is invalid:\n${missing}`);
  }
  return parsed.data;
}

export const userAgent = (botInfoUrl: string) => `SecondLookBot/1.0 (+${botInfoUrl})`;
