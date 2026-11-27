/**
 * pnpm eval
 * Runs the real checklist (rules + the real model) over every snapshot, compares
 * with the hand labels, and writes evals/results.md: accuracy per check, unsure
 * rate and cost. Costs money: run it from the manual GitHub Action or locally.
 * Needs ANTHROPIC_API_KEY and CLAUDE_MODEL.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHECKS, type CheckResult } from '@second-look/shared';
import { mergeChecklist, runRuleChecks, type AiOutcome } from '@second-look/shared/checklist.ts';
import { costUsd, createAnthropicClient } from '@second-look/worker/ai/anthropic.ts';
import { emptyUsage, runAiChecklist } from '@second-look/worker/ai/steps.ts';
import { EVALS_DIR, listSnapshots, loadLabels, loadSnapshot, pct, scoreEval } from './lib.ts';

const apiKey = process.env['ANTHROPIC_API_KEY'];
const model = process.env['CLAUDE_MODEL'];
if (!apiKey || !model) {
  console.error('Set ANTHROPIC_API_KEY and CLAUDE_MODEL.');
  process.exit(1);
}
const pricing = {
  inputPerMTok: Number(process.env['AI_INPUT_USD_PER_MTOK'] ?? '0.1'),
  outputPerMTok: Number(process.env['AI_OUTPUT_USD_PER_MTOK'] ?? '0.5'),
};
const ai = createAnthropicClient({ apiKey, model });
const ids = listSnapshots();
if (ids.length === 0) {
  console.error('No snapshots in evals/snapshots. Run pnpm eval:snapshot first.');
  process.exit(1);
}

const usage = emptyUsage();
const rows: Array<{ id: string; results: CheckResult[]; labels: ReturnType<typeof loadLabels>; retried: boolean; invalid: boolean }> = [];
for (const id of ids) {
  const snap = loadSnapshot(id);
  const page = { html: snap.html, visibleText: snap.visibleText, candidates: snap.candidates };
  const findings = runRuleChecks(page);
  const r = await runAiChecklist(ai, page, findings, snap.firstScreenPng, usage);
  const outcome: AiOutcome = r.ok ? { kind: 'answered', output: r.value } : { kind: 'invalid', error: r.error };
  rows.push({ id, results: mergeChecklist(page, findings, outcome), labels: loadLabels(id), retried: r.ok && r.retried, invalid: !r.ok });
  console.log(`${id}: ${r.ok ? 'ok' : `invalid (${r.error.slice(0, 80)})`}`);
}

const stats = scoreEval(rows);
const cost = costUsd(pricing, usage.inputTokens, usage.outputTokens);
const labelledSites = rows.filter((r) => r.labels && Object.values(r.labels.labels).some((v) => v !== null)).length;
const lines = [
  '# Eval results',
  '',
  `Run: ${new Date().toISOString()} · model \`${model}\` · ${rows.length} snapshots (${labelledSites} with labels)`,
  '',
  `Cost: $${cost.toFixed(4)} for ${usage.calls} calls (${usage.inputTokens} input / ${usage.outputTokens} output tokens) · $${(cost / rows.length).toFixed(5)} per site`,
  `Invalid AI output after retry: ${rows.filter((r) => r.invalid).length} · needed a retry: ${rows.filter((r) => r.retried).length}`,
  '',
  labelledSites === 0 ? '> No labels filled in yet, so accuracy can\'t be measured. Fill in `evals/labels/*.json` and run again.\n' : '',
  '| Check | Source | Accuracy (decided vs labels) | Labelled | Unsure (labelled) | Unsure (all) |',
  '|---|---|---|---|---|---|',
  ...CHECKS.map((c) => {
    const s = stats[c.id];
    return `| ${c.name} | ${c.source} | ${pct(s.correct, s.labelled - s.unsure)} | ${s.labelled} | ${pct(s.unsure, s.labelled)} | ${pct(s.unsureAll, s.total)} |`;
  }),
  '',
  'Accuracy counts only decided answers (pass/fail) against labels; unsure answers are reported separately and not scored either way.',
  '',
];
writeFileSync(join(EVALS_DIR, 'results.md'), lines.filter((l, i) => !(l === '' && lines[i - 1] === '')).join('\n'));
console.log(`\nWrote evals/results.md · cost $${cost.toFixed(4)}`);
