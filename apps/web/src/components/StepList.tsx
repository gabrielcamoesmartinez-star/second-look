import { STEP_LABELS, errorCopy, type AuditStepRow } from '@second-look/shared';

const badge: Record<AuditStepRow['status'], { label: string; cls: string }> = {
  queued: { label: 'Queued', cls: 'border border-dashed border-dim text-muted' },
  running: { label: 'Running', cls: 'bg-[rgba(170,200,255,0.12)] text-link' },
  retrying: { label: 'Retrying', cls: 'bg-[rgba(245,181,74,0.14)] text-warn' },
  done: { label: 'Done', cls: 'bg-[rgba(110,215,140,0.12)] text-pass' },
  failed: { label: 'Failed', cls: 'bg-[rgba(255,107,74,0.14)] text-fail' },
  skipped: { label: 'Skipped', cls: 'bg-surface-2 text-muted' },
};

export function StepList({ steps }: { steps: AuditStepRow[] }) {
  return (
    <ol className="divide-y divide-white/5 rounded-xl border border-line bg-surface" aria-live="polite">
      {steps.map((s) => {
        const b = badge[s.status];
        return (
          <li key={s.step} className="flex flex-wrap items-center gap-3 px-5 py-4">
            <span className="flex-1 font-medium">{STEP_LABELS[s.step]}</span>
            <span className={`rounded px-2 py-0.5 text-xs font-semibold ${b.cls}`}>
              {b.label}
              {s.status === 'retrying' ? ` · attempt ${s.attempt} of 3` : ''}
            </span>
            {(s.status === 'failed' || s.detail) && (
              <p className="w-full text-sm text-muted">{s.status === 'failed' ? errorCopy(s.error_code) : s.detail}</p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
