import { describe, expect, it } from 'vitest';
import { createRunner, type QueuePort } from '../src/jobRunner.ts';
import { silentLogger } from '../src/log.ts';

function fakeQueue(ids: string[]) {
  const pending = [...ids];
  const events: string[] = [];
  const queue: QueuePort = {
    claim: async () => {
      const id = pending.shift();
      if (id) events.push(`claim:${id}`);
      return id ? { audit_id: id, attempts: 1 } : null;
    },
    heartbeat: async () => true,
    finish: async (id) => void events.push(`finish:${id}`),
    release: async (id) => void events.push(`release:${id}`),
    requeueStale: async () => 0,
  };
  return { queue, events, pending };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('job runner', () => {
  it('never runs more than the concurrency cap', async () => {
    const { queue, events } = fakeQueue(['a', 'b', 'c', 'd']);
    let running = 0;
    let peak = 0;
    const runner = createRunner({
      queue, concurrency: 2, log: silentLogger, pollMs: 5, heartbeatMs: 1000,
      onCrash: async () => {},
      run: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await sleep(30);
        running -= 1;
        return 'complete';
      },
    });
    runner.start();
    await sleep(200);
    await runner.stop();
    expect(peak).toBe(2);
    expect(events.filter((e) => e.startsWith('finish')).sort()).toEqual(['finish:a', 'finish:b', 'finish:c', 'finish:d']);
  });

  it('on shutdown, aborts jobs past the grace period and releases them back to the queue', async () => {
    const { queue, events } = fakeQueue(['long']);
    const runner = createRunner({
      queue, concurrency: 2, log: silentLogger, pollMs: 5, heartbeatMs: 1000, shutdownGraceMs: 30,
      onCrash: async () => {},
      run: (_id, signal) =>
        new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
    });
    runner.start();
    await sleep(20);
    await runner.stop();
    expect(events).toEqual(['claim:long', 'release:long']);
  });

  it('aborts a job when its heartbeat reports the lock was lost', async () => {
    const { queue, events } = fakeQueue(['x']);
    queue.heartbeat = async () => false;
    let aborted = false;
    const runner = createRunner({
      queue, concurrency: 1, log: silentLogger, pollMs: 5, heartbeatMs: 10,
      onCrash: async () => {},
      run: (_id, signal) =>
        new Promise((_, reject) =>
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('lost'));
          }),
        ),
    });
    runner.start();
    await sleep(60);
    await runner.stop();
    expect(aborted).toBe(true);
    expect(events).not.toContain('finish:x'); // another worker owns it now
  });

  it('marks crashed jobs via onCrash and removes them from the queue', async () => {
    const { queue, events } = fakeQueue(['boom']);
    const crashed: string[] = [];
    const runner = createRunner({
      queue, concurrency: 1, log: silentLogger, pollMs: 5, heartbeatMs: 1000,
      onCrash: async (id) => void crashed.push(id),
      run: async () => {
        throw new Error('bug');
      },
    });
    runner.start();
    await sleep(30);
    await runner.stop();
    expect(crashed).toEqual(['boom']);
    expect(events).toContain('finish:boom');
  });
});
