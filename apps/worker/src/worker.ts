import type { SupabaseClient } from '@supabase/supabase-js';
import { userAgent, type Config } from './config';
import { log } from './log';
import { runAudit } from './pipeline';
import { fetchPage } from './steps/fetch';
import { runPageSpeed } from './steps/pagespeed';
import { supabaseReporter } from './supabaseReporter';

interface ClaimedJob {
  job_id: number;
  audit_id: string;
  attempts: number;
}

/** Polls the jobs table, runs up to `concurrency` audits at once, heartbeats, and shuts down cleanly. */
export class Worker {
  private running = new Map<number, Promise<void>>();
  private stopping = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly db: SupabaseClient, private readonly config: Config) {}

  start(): void {
    log('info', 'worker started', { worker: this.config.WORKER_ID, concurrency: this.config.WORKER_CONCURRENCY });
    void this.tick();
  }

  private schedule(): void {
    if (!this.stopping) this.timer = setTimeout(() => void this.tick(), this.config.POLL_INTERVAL_MS);
  }

  private async tick(): Promise<void> {
    try {
      await this.db.rpc('fail_exhausted_jobs');
      while (!this.stopping && this.running.size < this.config.WORKER_CONCURRENCY) {
        const { data, error } = await this.db.rpc('claim_job', { p_worker: this.config.WORKER_ID });
        if (error) throw new Error(error.message);
        const job = (data as ClaimedJob[] | null)?.[0];
        if (!job) break;
        this.running.set(job.job_id, this.run(job).finally(() => this.running.delete(job.job_id)));
      }
    } catch (err) {
      log('error', 'poll failed', { error: err instanceof Error ? err.message : String(err) });
    }
    this.schedule();
  }

  private async run(job: ClaimedJob): Promise<void> {
    log('info', 'job claimed', { audit_id: job.audit_id, attempt: job.attempts });
    const hb = setInterval(() => {
      void this.db.rpc('heartbeat_job', { p_job_id: job.job_id, p_worker: this.config.WORKER_ID });
    }, 20_000);
    try {
      const ua = userAgent(this.config.BOT_INFO_URL);
      await runAudit({
        reporter: supabaseReporter(this.db, job.audit_id),
        fetchPage: (url) => fetchPage(url, { userAgent: ua }),
        pageSpeed: (url, onRetry) => runPageSpeed(url, { apiKey: this.config.PAGESPEED_API_KEY, onRetry }),
      });
      await this.db.from('jobs').delete().eq('id', job.job_id);
    } catch (err) {
      // Leave the job locked; it becomes stale and is retried (max 3 attempts).
      log('error', 'job crashed', { audit_id: job.audit_id, error: err instanceof Error ? err.message : String(err) });
    } finally {
      clearInterval(hb);
    }
  }

  /** Stop claiming, give running audits up to `graceMs` to finish, then put the rest back in the queue. */
  async stop(graceMs = 25_000): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    const all = Promise.allSettled([...this.running.values()]);
    const timedOut = await Promise.race([all.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), graceMs))]);
    if (timedOut)
      for (const jobId of this.running.keys())
        await this.db.rpc('release_job', { p_job_id: jobId, p_worker: this.config.WORKER_ID });
    log('info', 'worker stopped', { released: timedOut ? this.running.size : 0 });
  }
}
