/**
 * Long-lived job loop.
 *  - Polls claim_job every 2s (SELECT … FOR UPDATE SKIP LOCKED) while below the concurrency cap.
 *  - Sends a heartbeat every 15s per job; if the lock is lost, the job is aborted.
 *  - Every 30s, re-queues jobs whose heartbeat is older than 2 minutes (any worker may do this).
 *  - On SIGTERM: stop claiming, give running jobs a grace period, then abort and release them.
 */
import { JOB_HEARTBEAT_INTERVAL_MS, JOB_POLL_INTERVAL_MS, JOB_STALE_AFTER_SECONDS } from '@second-look/shared';
import type { Logger } from './ports.ts';
import type { PipelineOutcome } from './pipeline/run.ts';

export interface QueuePort {
  claim(): Promise<{ audit_id: string; attempts: number } | null>;
  heartbeat(auditId: string): Promise<boolean>;
  finish(auditId: string): Promise<void>;
  release(auditId: string): Promise<void>;
  requeueStale(staleSeconds: number): Promise<number>;
}

export interface RunnerOptions {
  queue: QueuePort;
  concurrency: number;
  log: Logger;
  run: (auditId: string, signal: AbortSignal, log: Logger) => Promise<PipelineOutcome>;
  onCrash: (auditId: string, err: unknown) => Promise<void>;
  pollMs?: number;
  heartbeatMs?: number;
  shutdownGraceMs?: number;
}

export function createRunner(o: RunnerOptions) {
  const pollMs = o.pollMs ?? JOB_POLL_INTERVAL_MS;
  const heartbeatMs = o.heartbeatMs ?? JOB_HEARTBEAT_INTERVAL_MS;
  const active = new Map<string, { ctrl: AbortController; done: Promise<void> }>();
  let stopping = false;
  let pollTimer: NodeJS.Timeout | undefined;
  let staleTimer: NodeJS.Timeout | undefined;

  async function execute(auditId: string, attempts: number) {
    const ctrl = new AbortController();
    const log = o.log.child({ audit_id: auditId, attempt: attempts });
    const beat = setInterval(() => {
      o.queue
        .heartbeat(auditId)
        .then((ok) => {
          if (!ok) {
            log.warn('lost job lock, aborting');
            ctrl.abort(new Error('lock lost'));
          }
        })
        .catch((e) => log.warn('heartbeat failed', { err: String(e) }));
    }, heartbeatMs);

    const done = (async () => {
      try {
        log.info('job started');
        const outcome = await o.run(auditId, ctrl.signal, log);
        await o.queue.finish(auditId);
        log.info('job finished', { outcome });
      } catch (e) {
        if (ctrl.signal.aborted && stopping) {
          log.warn('job interrupted by shutdown; releasing');
          await o.queue.release(auditId).catch((err) => log.error('release failed', { err: String(err) }));
        } else if (ctrl.signal.aborted) {
          log.warn('job aborted');
        } else {
          log.error('job crashed', { err: e instanceof Error ? e.stack : String(e) });
          await o.onCrash(auditId, e).catch((err) => log.error('onCrash failed', { err: String(err) }));
          await o.queue.finish(auditId).catch(() => undefined);
        }
      } finally {
        clearInterval(beat);
        active.delete(auditId);
      }
    })();
    active.set(auditId, { ctrl, done });
  }

  async function tick() {
    if (stopping) return;
    try {
      while (!stopping && active.size < o.concurrency) {
        const job = await o.queue.claim();
        if (!job) break;
        void execute(job.audit_id, job.attempts);
      }
    } catch (e) {
      o.log.error('poll failed', { err: String(e) });
    } finally {
      if (!stopping) pollTimer = setTimeout(() => void tick(), pollMs);
    }
  }

  return {
    start() {
      o.log.info('worker started', { concurrency: o.concurrency });
      void tick();
      const sweep = () =>
        o.queue
          .requeueStale(JOB_STALE_AFTER_SECONDS)
          .then((n) => n > 0 && o.log.warn('re-queued stale jobs', { count: n }))
          .catch((e) => o.log.error('stale sweep failed', { err: String(e) }));
      void sweep();
      staleTimer = setInterval(() => void sweep(), 30_000);
    },
    async stop() {
      stopping = true;
      clearTimeout(pollTimer);
      clearInterval(staleTimer);
      const grace = o.shutdownGraceMs ?? 20_000;
      const all = Promise.all([...active.values()].map((a) => a.done));
      const timedOut = await Promise.race([all.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), grace))]);
      if (timedOut) {
        for (const a of active.values()) a.ctrl.abort(new Error('shutdown'));
        await all;
      }
      o.log.info('worker stopped');
    },
    get activeCount() {
      return active.size;
    },
  };
}
