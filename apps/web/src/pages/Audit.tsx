import { errorCopy } from '@second-look/shared';
import { Link, useParams } from 'react-router-dom';
import { Results } from '../components/Results';
import { StepList } from '../components/StepList';
import { useAudit } from '../hooks/useAudit';

export function Audit() {
  const { id = '' } = useParams();
  const state = useAudit(id);

  if (state.kind === 'loading') return <p className="text-muted" aria-busy="true">Loading audit…</p>;
  if (state.kind === 'error')
    return (
      <div role="alert">
        <p className="text-fail">{state.message}</p>
        <Link to="/audits">Back to your audits</Link>
      </div>
    );

  const { audit, steps } = state;
  const finished = ['complete', 'partial', 'failed', 'cancelled'].includes(audit.status);
  return (
    <article>
      <Link to="/audits" className="text-sm">← All audits</Link>
      <h1 className="mt-4 break-all font-mono text-2xl">{(audit.final_url ?? audit.input_url).replace(/^https?:\/\//, '')}</h1>
      <p className="mt-1 text-sm text-muted">
        {finished
          ? `Finished ${audit.completed_at ? new Date(audit.completed_at).toLocaleString() : ''}${audit.duration_ms ? ` · took ${Math.round(audit.duration_ms / 1000)} s` : ''}`
          : 'Running. You can leave this page; the audit keeps going.'}
      </p>
      {audit.status === 'failed' && (
        <p role="alert" className="mt-4 rounded-lg bg-[rgba(255,107,74,0.10)] p-4 text-fail">{errorCopy(audit.error_code)}</p>
      )}
      {audit.status === 'partial' && (
        <p className="mt-4 rounded-lg bg-[rgba(245,181,74,0.10)] p-4 text-warn">
          Some checks couldn't run: {errorCopy(audit.error_code)} The rest of the results are below.
        </p>
      )}
      <div className="mt-6">
        <StepList steps={steps} />
      </div>
      {(audit.status === 'complete' || audit.status === 'partial') && <Results audit={audit} />}
    </article>
  );
}
