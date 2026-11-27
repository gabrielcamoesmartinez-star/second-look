/**
 * The two AI steps. Each validates the model's output with Zod and retries
 * once with the validation error included; a second failure falls back to
 * "unsure" (checklist) or no summary.
 */
import {
  buildChecklistUserText,
  CHECKLIST_SYSTEM_PROMPT,
  parseAiChecklist,
  type AiChecklistOutput,
  type PageFacts,
  type RuleFindings,
} from '@second-look/shared/checklist.ts';
import { buildSummaryUserText, SUMMARY_SYSTEM_PROMPT, validateSummary, type SummaryInput } from '@second-look/shared/summary.ts';
import type { AiClient, AiContent, AiMessage } from './anthropic.ts';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  calls: number;
}
export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, calls: 0 });

async function askWithRetry<T>(
  ai: AiClient,
  system: string,
  first: AiMessage,
  maxTokens: number,
  validate: (text: string) => { ok: true; value: T } | { ok: false; error: string },
  usage: Usage,
  signal?: AbortSignal,
): Promise<{ ok: true; value: T; retried: boolean } | { ok: false; error: string }> {
  const messages: AiMessage[] = [first];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const reply = await ai.complete({ system, messages, maxTokens, signal });
    usage.inputTokens += reply.inputTokens;
    usage.outputTokens += reply.outputTokens;
    usage.calls += 1;
    const v = validate(reply.text);
    if (v.ok) return { ok: true, value: v.value, retried: attempt > 1 };
    if (attempt === 2) return { ok: false, error: v.error };
    messages.push({ role: 'assistant', content: reply.text || '(empty)' }, { role: 'user', content: `${v.error}\nReply again with only the corrected JSON.` });
  }
  return { ok: false, error: 'unreachable' };
}

export async function runAiChecklist(
  ai: AiClient,
  page: PageFacts,
  findings: RuleFindings,
  firstScreenPng: Buffer,
  usage: Usage,
  signal?: AbortSignal,
): Promise<{ ok: true; value: AiChecklistOutput; retried: boolean } | { ok: false; error: string }> {
  const ids = new Set(page.candidates.map((c) => c.id));
  const content: AiContent[] = [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: firstScreenPng.toString('base64') } },
    { type: 'text', text: buildChecklistUserText(page, findings) },
  ];
  return askWithRetry(ai, CHECKLIST_SYSTEM_PROMPT, { role: 'user', content }, 1500, (t) => parseAiChecklist(t, ids), usage, signal);
}

export async function runAiSummary(
  ai: AiClient,
  input: SummaryInput,
  usage: Usage,
  signal?: AbortSignal,
): Promise<{ ok: true; value: string; retried: boolean } | { ok: false; error: string }> {
  return askWithRetry(
    ai,
    SUMMARY_SYSTEM_PROMPT,
    { role: 'user', content: buildSummaryUserText(input) },
    600,
    (t) => validateSummary(t, input),
    usage,
    signal,
  );
}
