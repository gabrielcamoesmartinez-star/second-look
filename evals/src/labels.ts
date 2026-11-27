/**
 * pnpm eval:labels
 * Creates an EMPTY label file for every snapshot that doesn't have one yet.
 * It never fills in answers: a person opens the snapshot and sets each check
 * to "pass" or "fail" (or leaves null if it can't be told).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CheckId } from '@second-look/shared';
import { LABELS_DIR, listSnapshots, loadSnapshot, type LabelFile } from './lib.ts';

mkdirSync(LABELS_DIR, { recursive: true });
let created = 0;
for (const id of listSnapshots()) {
  const p = join(LABELS_DIR, `${id}.json`);
  if (existsSync(p)) continue;
  const snap = loadSnapshot(id);
  const file: LabelFile = {
    site: id,
    url: snap.url,
    labelled_by: null,
    labels: Object.fromEntries(CheckId.options.map((c) => [c, null])) as LabelFile['labels'],
    notes: 'Open snapshots/' + id + '/first-screen.png and the live site. Set each check to "pass" or "fail". Leave null if you cannot tell. Put your name in labelled_by.',
  };
  writeFileSync(p, JSON.stringify(file, null, 2) + '\n');
  created += 1;
}
console.log(`${created} empty label file(s) created in evals/labels/.`);
