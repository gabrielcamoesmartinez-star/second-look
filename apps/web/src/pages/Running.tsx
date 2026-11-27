import { errorCopy, MAX_STEP_ATTEMPTS, PIPELINE_STEPS, type AuditStepRow } from '@second-look/shared';
import { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { signedArtifactUrl, TERMINAL } from '../lib/api.ts';
import { useLiveAudit } from '../lib/useAudit.ts';

const LABELS: Record<string, string> = {
  fetch: 'Open the page on a phone',
  performance: 'Measure speed (Google PageSpeed)',
  accessibility: 'Check accessibility (Google PageSpeed)',
  seo: 'Check search basics',
  checklist_ai: 'Check the enquiry checklist (rules + AI)',
  summary: 'Write the plain-English summary',
};

export function Running() {
  const { id = '' } = useParams();
  const { audit, steps, error, loading } = useLiveAudit(id);
  const [shot, setShot] = useState<string | null>(null);

  useEffect(() => {
    if (audit?.screenshot_path && !shot) void signedArtifactUrl(audit.screenshot_path).then(setShot);
  }, [audit?.screenshot_path, shot]);

  if (audit && TERMINAL.has(audit.status)) return <Navigate to={`/audits/${id}`} replace />;
  if (!loading && !audit) return <main className="p-8"><p>We couldn't find that audit.</p></main>;

  const byStep = new Map(steps.map((s) => [s.step, s]));
  const current = PIPELINE_STEPS.map((s) => byStep.get(s)).find((s) => s?.status === 'running' || s?.status === 'retrying');

  return (
    <main className="mx-auto max-w-4xl p-6" aria-busy={!audit || !TERMINAL.has(audit.status)}>
      <p className="font-mono text-xs uppercase tracking-wider text-dim">Auditing</p>
      <h1 className="mt-1 break-all font-mono text-2xl">{audit?.input_url ?? '…'}</h1>
      {error && <p role="alert" className="mt-4 text-fail">Lost connection: {error}. Retrying…</p>}

      <p className="sr-only" aria-live="polite">
        {current ? `${LABELS[current.step]}: ${current.status}${current.status === 'retrying' ? `, attempt ${current.attempt} of ${MAX_STEP_ATTEMPTS}` : ''}` : ''}
      </p>

      <div className="mt-6 grid gap-6 md:grid-cols-[1fr_220px]">
        <ol className="space-y-2">
          {PIPELINE_STEPS.map((name) => (
            <StepItem key={name} name={name} step={byStep.get(name)} />
          ))}
        </ol>
        <figure className="rounded border border-line p-2">
          {shot ? (
            <img src={shot} alt={`First screen of ${audit?.input_url ?? 'the site'} on a phone`} className="w-full rounded" />
          ) : (
            <div className="aspect-[390/844] animate-pulse rounded bg-surface-2" aria-hidden="true" />
          )}
          <figcaption className="mt-2 font-mono text-xs uppercase tracking-wider text-dim">What the phone sees</figcaption>
        </figure>
      </div>
    </main>
  );
}

function StepItem({ name, step }: { name: string; step: AuditStepRow | undefined }) {
  const status = step?.status ?? 'queued';
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded border border-line bg-surface p-3">
      <span>{LABELS[name] ?? name}</span>
      <span className="flex items-center gap-2">
        {status === 'retrying' && step && <span className="font-mono text-xs text-warn">attempt {step.attempt} of {MAX_STEP_ATTEMPTS}</span>}
        {status === 'failed' && step?.error_code && <span className="text-xs text-fail">{errorCopy(step.error_code).message}</span>}
        {status === 'done' && step?.detail && <span className="font-mono text-xs text-muted">{step.detail}</span>}
        <StatusBadge status={status} />
      </span>
    </li>
  );
}
