import type { AuditStatus, StepName } from '@second-look/shared';
import type { Reporter } from '../src/reporter';

export function memoryReporter(inputUrl = 'https://example.com/') {
  const state = {
    audit: { id: 'a1', userId: 'u1', inputUrl, status: 'queued' as AuditStatus } as Record<string, unknown> & { status: AuditStatus },
    steps: {} as Record<string, { status: string; attempt?: number; error_code?: string | null; detail?: string | null; history: string[] }>,
    uploads: [] as string[],
    cancelAfterFetch: false,
  };
  const reporter: Reporter = {
    async getAudit() {
      return { id: 'a1', userId: 'u1', inputUrl, status: state.audit.status };
    },
    async setAudit(patch) {
      Object.assign(state.audit, patch);
    },
    async setStep(step: StepName, patch) {
      const prev = state.steps[step] ?? { status: 'queued', history: [] };
      state.steps[step] = { ...prev, ...patch, history: [...prev.history, patch.status] };
    },
    async upload(path) {
      state.uploads.push(path);
    },
    async isCancelled() {
      return state.cancelAfterFetch && state.uploads.length > 0;
    },
  };
  return { state, reporter };
}
