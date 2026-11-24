import { createClient } from '@supabase/supabase-js';
import { loadConfig } from './config';
import { log } from './log';
import { closeBrowser } from './steps/fetch';
import { Worker } from './worker';

const config = loadConfig();
const db = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const worker = new Worker(db, config);
worker.start();

let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', 'shutdown requested', { signal });
    void worker
      .stop()
      .then(closeBrowser)
      .finally(() => process.exit(0));
  });
}
