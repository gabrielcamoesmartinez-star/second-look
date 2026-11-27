/**
 * Eval set: real local business sites saved as snapshots (first-screen
 * screenshot + rendered HTML + visible text + candidate elements), so a run is
 * reproducible. Labels are filled in by hand (by Gabriel), never generated.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Candidate, CheckId, type CheckResult } from '@second-look/shared';
import { z } from 'zod';

export const EVALS_DIR = join(import.meta.dirname, '..');
export const SNAPSHOTS_DIR = join(EVALS_DIR, 'snapshots');
export const LABELS_DIR = join(EVALS_DIR, 'labels');

export const SitesFile = z.object({ sites: z.array(z.object({ id: z.string().regex(/^[a-z0-9-]+$/), url: z.string().url() })) });

/** One label per check: "pass", "fail", or null (not labelled yet / can't tell). */
export const LabelFile = z.object({
  site: z.string(),
  url: z.string(),
  labelled_by: z.string().nullable(),
  labels: z.record(CheckId, z.enum(['pass', 'fail']).nullable()),
  notes: z.string().optional(),
});
export type LabelFile = z.infer<typeof LabelFile>;

export interface Snapshot {
  id: string;
  url: string;
  html: string;
  visibleText: string;
  candidates: Candidate[];
  firstScreenPng: Buffer;
}

export function listSnapshots(): string[] {
  if (!existsSync(SNAPSHOTS_DIR)) return [];
  return readdirSync(SNAPSHOTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(SNAPSHOTS_DIR, d.name, 'meta.json')))
    .map((d) => d.name)
    .sort();
}

export function loadSnapshot(id: string): Snapshot {
  const dir = join(SNAPSHOTS_DIR, id);
  const meta = z.object({ url: z.string() }).parse(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')));
  return {
    id,
    url: meta.url,
    html: readFileSync(join(dir, 'page.html'), 'utf8'),
    visibleText: readFileSync(join(dir, 'visible-text.txt'), 'utf8'),
    candidates: z.array(Candidate).parse(JSON.parse(readFileSync(join(dir, 'candidates.json'), 'utf8'))),
    firstScreenPng: readFileSync(join(dir, 'first-screen.png')),
  };
}

export function loadLabels(id: string): LabelFile | null {
  const p = join(LABELS_DIR, `${id}.json`);
  return existsSync(p) ? LabelFile.parse(JSON.parse(readFileSync(p, 'utf8'))) : null;
}

export interface CheckStats {
  labelled: number;
  correct: number;
  /** Results "unsure" among labelled items (not counted as correct or wrong). */
  unsure: number;
  /** Unsure among all predictions for this check, labelled or not. */
  unsureAll: number;
  total: number;
}

/** Accuracy per check: decided predictions vs hand labels. Unsure is reported separately, not scored. */
export function scoreEval(rows: Array<{ id: string; results: CheckResult[]; labels: LabelFile | null }>): Record<CheckId, CheckStats> {
  const stats = Object.fromEntries(CheckId.options.map((c) => [c, { labelled: 0, correct: 0, unsure: 0, unsureAll: 0, total: 0 }])) as Record<CheckId, CheckStats>;
  for (const row of rows) {
    for (const r of row.results) {
      const s = stats[r.check_id];
      s.total += 1;
      if (r.result === 'unsure') s.unsureAll += 1;
      const label = row.labels?.labels[r.check_id] ?? null;
      if (label === null) continue;
      s.labelled += 1;
      if (r.result === 'unsure') s.unsure += 1;
      else if (r.result === label) s.correct += 1;
    }
  }
  return stats;
}

export function pct(n: number, d: number): string {
  return d === 0 ? '—' : `${Math.round((n / d) * 100)}%`;
}
