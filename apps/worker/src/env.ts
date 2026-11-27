import { z } from 'zod';

const Env = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  PAGESPEED_API_KEY: z.string().min(10),
  ANTHROPIC_API_KEY: z.string().min(20).optional(),
  CLAUDE_MODEL: z.string().min(3).optional(),
  DAILY_AI_BUDGET_USD: z.coerce.number().min(0).default(0.5),
  /** USD per million tokens. Defaults are Claude Haiku 5.5 list prices (prompts ≤100K tokens). */
  AI_INPUT_USD_PER_MTOK: z.coerce.number().min(0).default(0.1),
  AI_OUTPUT_USD_PER_MTOK: z.coerce.number().min(0).default(0.5),
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
  if (parsed.data.ANTHROPIC_API_KEY && !parsed.data.CLAUDE_MODEL) {
    throw new Error('CLAUDE_MODEL must be set when ANTHROPIC_API_KEY is set. See .env.example.');
  }
  return parsed.data;
}
