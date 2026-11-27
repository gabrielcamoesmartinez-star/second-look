/**
 * RLS and queue tests. Needs DATABASE_URL pointing at an EMPTY Postgres 15+
 * database (CI uses a postgres service container; locally: scripts/pg-test.sh).
 * The Supabase shim + every migration are applied fresh.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env['DATABASE_URL'];
if (!url) throw new Error('DATABASE_URL is required for DB tests');

const db = new pg.Client({ connectionString: url });
const root = join(__dirname, '..', '..');

let alice: string;
let bob: string;
let aliceAudit: string;
let bobAudit: string;

async function as<T>(role: 'anon' | 'authenticated' | 'service_role', sub: string | null, fn: () => Promise<T>): Promise<T> {
  await db.query('begin');
  try {
    await db.query(`set local role ${role}`);
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(sub ? { sub, role } : { role })]);
    const out = await fn();
    await db.query('commit');
    return out;
  } catch (e) {
    await db.query('rollback');
    throw e;
  }
}

beforeAll(async () => {
  await db.connect();
  await db.query('drop schema if exists public cascade; create schema public; drop schema if exists auth cascade;');
  await db.query('grant all on schema public to public');
  await db.query(readFileSync(join(__dirname, 'supabase-shim.sql'), 'utf8'));
  const migrations = readdirSync(join(root, 'supabase', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  for (const m of migrations) await db.query(readFileSync(join(root, 'supabase', 'migrations', m), 'utf8'));

  alice = (await db.query(`insert into auth.users (email) values ('alice@test.local') returning id`)).rows[0].id;
  bob = (await db.query(`insert into auth.users (email) values ('bob@test.local') returning id`)).rows[0].id;
  aliceAudit = (await db.query(`select audit_id from reserve_audit($1, 'ip-a', 'https://a.example/', 3, 10)`, [alice])).rows[0].audit_id;
  bobAudit = (await db.query(`select audit_id from reserve_audit($1, 'ip-b', 'https://b.example/', 3, 10)`, [bob])).rows[0].audit_id;
});

afterAll(async () => {
  await db.end();
});

describe('RLS', () => {
  it('creates a profile on sign-up', async () => {
    const r = await db.query('select count(*)::int as n from profiles');
    expect(r.rows[0].n).toBe(2);
  });

  it("user A sees only A's audits and steps", async () => {
    const rows = await as('authenticated', alice, async () => (await db.query('select id from audits')).rows);
    expect(rows.map((r) => r.id)).toEqual([aliceAudit]);
    const steps = await as('authenticated', alice, async () => (await db.query('select distinct audit_id from audit_steps')).rows);
    expect(steps.map((r) => r.audit_id)).toEqual([aliceAudit]);
  });

  it("user A cannot read B's audit by id", async () => {
    const rows = await as('authenticated', alice, async () => (await db.query('select id from audits where id = $1', [bobAudit])).rows);
    expect(rows).toEqual([]);
  });

  it('anon sees nothing', async () => {
    const rows = await as('anon', null, async () => (await db.query('select id from audits')).rows);
    expect(rows).toEqual([]);
  });

  it('users cannot write audits directly (quota bypass)', async () => {
    await expect(
      as('authenticated', alice, () => db.query(`insert into audits (user_id, input_url) values ($1, 'https://x.example')`, [alice])),
    ).rejects.toThrow(/permission denied/);
    await expect(as('authenticated', alice, () => db.query(`update audits set score = 100 where id = $1`, [aliceAudit]))).rejects.toThrow(
      /permission denied/,
    );
  });

  it('users cannot touch the queue or call service functions', async () => {
    await expect(as('authenticated', alice, () => db.query('select * from jobs'))).rejects.toThrow(/permission denied/);
    await expect(as('authenticated', alice, () => db.query(`select * from claim_job('evil')`))).rejects.toThrow(/permission denied/);
    await expect(
      as('authenticated', alice, () => db.query(`select * from reserve_audit($1, 'x', 'https://x.example', 999, 999)`, [alice])),
    ).rejects.toThrow(/permission denied/);
  });

  it('a share token exposes exactly that one report and no account data', async () => {
    const token = 'a'.repeat(40);
    await db.query('update audits set share_token = $1 where id = $2', [token, aliceAudit]);
    const report = await as('anon', null, async () => (await db.query('select get_shared_report($1) as r', [token])).rows[0].r);
    expect(report.audit.id).toBe(aliceAudit);
    expect(report.audit.user_id).toBeUndefined();
    expect(report.audit.share_token).toBeUndefined();
    expect(report.steps.every((s: { audit_id: string }) => s.audit_id === aliceAudit)).toBe(true);

    const wrong = await as('anon', null, async () => (await db.query('select get_shared_report($1) as r', ['b'.repeat(40)])).rows[0].r);
    expect(wrong).toBeNull();
    const short = await as('anon', null, async () => (await db.query(`select get_shared_report('') as r`)).rows[0].r);
    expect(short).toBeNull();
    // The token does not grant table access.
    const rows = await as('anon', null, async () => (await db.query('select id from audits')).rows);
    expect(rows).toEqual([]);
  });
});

describe('quota', () => {
  it('enforces the per-user daily limit', async () => {
    const carol = (await db.query(`insert into auth.users (email) values ('carol@test.local') returning id`)).rows[0].id;
    for (let i = 0; i < 3; i++) await db.query(`select * from reserve_audit($1, 'ip-c', 'https://c.example', 3, 10)`, [carol]);
    await expect(db.query(`select * from reserve_audit($1, 'ip-c', 'https://c.example', 3, 10)`, [carol])).rejects.toThrow(/quota_exceeded/);
    const remaining = await as('authenticated', carol, async () => (await db.query('select quota_remaining(3) as n')).rows[0].n);
    expect(remaining).toBe(0);
  });

  it('resets after quota_reset_at', async () => {
    const dan = (await db.query(`insert into auth.users (email) values ('dan@test.local') returning id`)).rows[0].id;
    await db.query(`update profiles set audits_today = 3, quota_reset_at = now() - interval '1 second' where id = $1`, [dan]);
    const r = await db.query(`select * from reserve_audit($1, 'ip-d', 'https://d.example', 3, 10)`, [dan]);
    expect(r.rows[0].remaining).toBe(2);
  });

  it('enforces the per-IP limit across users', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await db.query(`insert into auth.users (email) values ($1) returning id`, [`ip${i}@t.local`])).rows[0].id);
    await db.query(`select * from reserve_audit($1, 'shared-ip', 'https://e.example', 3, 2)`, [ids[0]]);
    await db.query(`select * from reserve_audit($1, 'shared-ip', 'https://e.example', 3, 2)`, [ids[1]]);
    await expect(db.query(`select * from reserve_audit($1, 'shared-ip', 'https://e.example', 3, 2)`, [ids[2]])).rejects.toThrow(/ip_rate_limited/);
    const counted = await db.query(`select audits_today from profiles where id = $1`, [ids[2]]);
    expect(counted.rows[0].audits_today).toBe(0); // the failed attempt rolled back
  });
});

describe('job queue', () => {
  it('two workers never claim the same job (SKIP LOCKED)', async () => {
    await db.query('delete from jobs');
    const u = (await db.query(`insert into auth.users (email) values ('q@t.local') returning id`)).rows[0].id;
    await db.query(`select * from reserve_audit($1, 'ip-q', 'https://q1.example', 9, 99)`, [u]);
    await db.query(`select * from reserve_audit($1, 'ip-q', 'https://q2.example', 9, 99)`, [u]);

    const w1 = new pg.Client({ connectionString: url });
    const w2 = new pg.Client({ connectionString: url });
    await Promise.all([w1.connect(), w2.connect()]);
    await w1.query('begin');
    const a = await w1.query(`select * from claim_job('w1')`); // holds its row lock until commit
    const b = await w2.query(`select * from claim_job('w2')`);
    await w1.query('commit');
    const c = await w2.query(`select * from claim_job('w2')`);
    await Promise.all([w1.end(), w2.end()]);

    expect(a.rows).toHaveLength(1);
    expect(b.rows).toHaveLength(1);
    expect(a.rows[0].audit_id).not.toBe(b.rows[0].audit_id);
    expect(c.rows).toHaveLength(0);
  });

  it('heartbeats only succeed for the lock owner', async () => {
    const job = (await db.query(`select audit_id from jobs where locked_by = 'w1'`)).rows[0].audit_id;
    expect((await db.query(`select heartbeat_job($1, 'w1') as ok`, [job])).rows[0].ok).toBe(true);
    expect((await db.query(`select heartbeat_job($1, 'w2') as ok`, [job])).rows[0].ok).toBeNull();
  });

  it('re-queues jobs with a stale heartbeat, and fails them after max attempts', async () => {
    await db.query(`update jobs set heartbeat_at = now() - interval '3 minutes'`);
    await db.query(`update jobs set attempts = 3 where locked_by = 'w2'`);
    const poisoned = (await db.query(`select audit_id from jobs where locked_by = 'w2'`)).rows[0].audit_id;
    const n = (await db.query('select requeue_stale_jobs(120, 3) as n')).rows[0].n;
    expect(n).toBe(1);
    const left = await db.query('select locked_by from jobs');
    expect(left.rows).toEqual([{ locked_by: null }]);
    const failed = await db.query('select status from audits where id = $1', [poisoned]);
    expect(failed.rows[0].status).toBe('failed');
  });

  it('release_job puts a job back without counting the attempt', async () => {
    const claimed = (await db.query(`select * from claim_job('w3')`)).rows[0];
    await db.query(`select release_job($1, 'w3')`, [claimed.audit_id]);
    const row = (await db.query('select locked_by, attempts from jobs where audit_id = $1', [claimed.audit_id])).rows[0];
    expect(row.locked_by).toBeNull();
    expect(row.attempts).toBe(claimed.attempts - 1);
  });
});

describe('stage 2', () => {
  it('new audits get all six steps', async () => {
    const u = (await db.query(`insert into auth.users (email) values ('s2@t.local') returning id`)).rows[0].id;
    const a = (await db.query(`select audit_id from reserve_audit($1, 'ip-s2', 'https://s2.example/', 3, 10)`, [u])).rows[0].audit_id;
    const steps = (await db.query('select step::text from audit_steps where audit_id = $1 order by step', [a])).rows.map((r) => r.step);
    expect(steps.sort()).toEqual(['accessibility', 'checklist_ai', 'fetch', 'performance', 'seo', 'summary']);
  });

  it('find_recent_audit returns only the same user\'s finished audit of that URL within 24h', async () => {
    const u = (await db.query(`insert into auth.users (email) values ('cache@t.local') returning id`)).rows[0].id;
    const other = (await db.query(`insert into auth.users (email) values ('cache2@t.local') returning id`)).rows[0].id;
    const a = (await db.query(`select audit_id from reserve_audit($1, 'ip-c1', 'https://cache.example/', 9, 99)`, [u])).rows[0].audit_id;
    const find = async (user: string, url: string) => (await db.query('select find_recent_audit($1, $2) as id', [user, url])).rows[0].id;
    expect(await find(u, 'https://cache.example/')).toBeNull(); // still queued
    await db.query(`update audits set status = 'complete' where id = $1`, [a]);
    expect(await find(u, 'https://cache.example/')).toBe(a);
    expect(await find(other, 'https://cache.example/')).toBeNull();
    expect(await find(u, 'https://other.example/')).toBeNull();
    await db.query(`update audits set created_at = now() - interval '25 hours' where id = $1`, [a]);
    expect(await find(u, 'https://cache.example/')).toBeNull();
    await expect(as('authenticated', u, () => db.query('select find_recent_audit($1, $2)', [u, 'https://cache.example/']))).rejects.toThrow(/permission denied/);
  });
});
