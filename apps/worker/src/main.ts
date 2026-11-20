import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { botUserAgent, ERROR_COPY, MAX_CONCURRENT_JOBS } from '@second-look/shared';
import { loadEnv } from './env.ts';
import { createLogger } from './log.ts';
import { createRunner } from './jobRunner.ts';
import { BROWSER_ARGS } from './pipeline/capture.ts';
import { createSafeFetch, defaultResolver } from './net/safeFetch.ts';
import { createPageSpeedClient } from './pipeline/pagespeed.ts';
import { runAudit } from './pipeline/run.ts';
import { serviceClient, supabaseBlobs, supabaseQueue, supabaseStore } from './supabase.ts';

const env = loadEnv();
const workerId = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
const log = createLogger({ service: 'worker', worker_id: workerId });

const db = serviceClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const store = supabaseStore(db);
const blobs = supabaseBlobs(db);
const queue = supabaseQueue(db, workerId);
const pagespeed = createPageSpeedClient(env.PAGESPEED_API_KEY);
const safeFetch = createSafeFetch({ resolve: defaultResolver });
const userAgent = botUserAgent(env.PUBLIC_SITE_URL);

const browser = await chromium.launch({
  executablePath: env.CHROMIUM_PATH,
  // Every request is fulfilled by safeFetch via route(). The dead proxy means anything
  // that slips past route() (it shouldn't) fails instead of reaching the network.
  args: [...BROWSER_ARGS],
});

const runner = createRunner({
  queue,
  concurrency: Math.min(env.WORKER_CONCURRENCY, MAX_CONCURRENT_JOBS),
  log,
  run: (auditId, signal, jobLog) => runAudit(auditId, { store, blobs, pagespeed, browser, safeFetch, userAgent, log: jobLog, signal }),
  onCrash: (auditId) =>
    store.updateAudit(auditId, {
      status: 'failed',
      error_code: 'internal',
      error_message: ERROR_COPY.internal.message,
      completed_at: new Date().toISOString(),
    }),
});

runner.start();

let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutdown requested', { signal: sig });
    void runner
      .stop()
      .then(() => browser.close())
      .finally(() => process.exit(0));
  });
}
