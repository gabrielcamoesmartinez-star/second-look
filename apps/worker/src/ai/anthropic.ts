/**
 * Minimal Anthropic Messages API client (fetch, no SDK). The model id comes
 * from CLAUDE_MODEL; it is never hard-coded.
 */
import { z } from 'zod';

export type AiContent =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg'; data: string } };

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string | AiContent[];
}

export interface AiRequest {
  system: string;
  messages: AiMessage[];
  maxTokens: number;
  signal?: AbortSignal;
}

export interface AiReply {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AiClient {
  readonly model: string;
  complete(req: AiRequest): Promise<AiReply>;
}

const ApiResponse = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  usage: z.object({ input_tokens: z.number().int(), output_tokens: z.number().int() }),
});

const TIMEOUT_MS = 60_000;
const RETRIABLE = new Set([408, 429, 500, 502, 503, 504, 529]);

export function createAnthropicClient(opts: { apiKey: string; model: string; fetchImpl?: typeof fetch }): AiClient {
  const f = opts.fetchImpl ?? fetch;
  return {
    model: opts.model,
    async complete(req) {
      let lastError = '';
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (attempt > 1) await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 2)));
        const timeout = AbortSignal.timeout(TIMEOUT_MS);
        let res: Response;
        try {
          res = await f('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
            body: JSON.stringify({ model: opts.model, max_tokens: req.maxTokens, system: req.system, messages: req.messages }),
            signal: req.signal ? AbortSignal.any([req.signal, timeout]) : timeout,
          });
        } catch (e) {
          if (req.signal?.aborted) throw e;
          lastError = e instanceof Error ? e.message : String(e);
          continue;
        }
        if (!res.ok) {
          lastError = `Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
          if (RETRIABLE.has(res.status)) continue;
          throw new Error(lastError);
        }
        const data = ApiResponse.parse(await res.json());
        return {
          text: data.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join(''),
          inputTokens: data.usage.input_tokens,
          outputTokens: data.usage.output_tokens,
        };
      }
      throw new Error(lastError || 'Anthropic request failed');
    },
  };
}

export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

export function costUsd(p: Pricing, inputTokens: number, outputTokens: number): number {
  return (inputTokens * p.inputPerMTok + outputTokens * p.outputPerMTok) / 1_000_000;
}
