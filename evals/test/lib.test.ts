import { describe, expect, it } from 'vitest';
import type { CheckResult } from '@second-look/shared';
import { scoreEval, type LabelFile } from '../src/lib.ts';

const r = (check_id: CheckResult['check_id'], result: CheckResult['result']): CheckResult => ({
  check_id,
  result,
  confidence: 0.9,
  evidence: '',
  evidence_selector: null,
  box: null,
  source: 'ai',
});
const labels = (l: Partial<LabelFile['labels']>): LabelFile => ({ site: 's', url: 'https://s.example', labelled_by: 'test', labels: l as LabelFile['labels'] });

describe('scoreEval', () => {
  it('counts decided answers against labels and keeps unsure separate', () => {
    const stats = scoreEval([
      { id: 'a', results: [r('location_stated', 'pass'), r('hours_visible', 'unsure')], labels: labels({ location_stated: 'pass', hours_visible: 'pass' }) },
      { id: 'b', results: [r('location_stated', 'fail'), r('hours_visible', 'fail')], labels: labels({ location_stated: 'pass', hours_visible: null }) },
      { id: 'c', results: [r('location_stated', 'pass')], labels: null },
    ]);
    expect(stats.location_stated).toEqual({ labelled: 2, correct: 1, unsure: 0, unsureAll: 0, total: 3 });
    expect(stats.hours_visible).toEqual({ labelled: 1, correct: 0, unsure: 1, unsureAll: 1, total: 2 });
  });
});
