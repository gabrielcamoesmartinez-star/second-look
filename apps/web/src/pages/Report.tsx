import { errorCopy, type PageSpeedSummary } from '@second-look/shared';
import { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { signedArtifactUrl, TERMINAL } from '../lib/api.ts';
import { useLiveAudit } from '../lib/useAudit.ts';

/** Stage 1 basic report: real PageSpeed and SEO results. Gauge, fixes and checklist arrive in Stages 2–4. */
export function Report() {
  const { id = '' } = useParams();
  const { audit, steps, loading, error } = useLiveAudit(id);
  const [shot, setShot] = useState<string | null>(null);

  useEffect(() => {
    if (audit?.screenshot_path) void signedArtifactUrl(audit.screenshot_path).then(setShot);
  }, [audit?.screenshot_path]);

  if (loading) return <p aria-busy="true" className="p-8 text-muted">Loading report…</p>;
  if (error && !audit) return <p role="alert" className="p-8 text-fail">Couldn't load this report. {error}</p>;
  if (!audit) return <main className="p-8"><p>We couldn't find that audit.</p></main>;
  if (!TERMINAL.has(audit.status)) return <Navigate to={`/audits/${id}/running`} replace />;

  const cats = audit.category_scores ?? {};
  const stepFor = (s: string) => steps.find((x) => x.step === s);
  const copy = audit.error_code ? errorCopy(audit.error_code) : null;

  return (
    <main className="mx-auto max-w-5xl p-6">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="break-all font-mono text-2xl">{audit.final_url ?? audit.input_url}</h1>
          <p className="mt-1 font-mono text-xs uppercase tracking-wider text-dim">
            {new Date(audit.created_at).toLocaleString()}
            {audit.duration_ms !== null && ` · ${(audit.duration_ms / 1000).toFixed(1)}s`}
          </p>
        </div>
        <StatusBadge status={audit.status} />
      </header>

      {copy && (
        <div role="alert" className="mt-6 rounded border border-fail/40 p-4">
          <p className="text-fail">{copy.message}</p>
          <p className="mt-1 text-muted">{copy.action}</p>
        </div>
      )}

      {audit.status !== 'failed' && (
        <>
          <section className="mt-8 grid gap-4 md:grid-cols-3" aria-label="Category scores">
            <CategoryCard title="Performance" summary={cats.performance} reason={stepFor('performance')?.error_code} />
            <CategoryCard title="Accessibility" summary={cats.accessibility} reason={stepFor('accessibility')?.error_code} />
            <div className="rounded border border-line bg-surface p-4">
              <h2 className="font-mono text-xs uppercase tracking-wider text-dim">Search basics</h2>
              <p className="mt-2 font-mono text-4xl">{cats.seo ? cats.seo.score : '—'}</p>
            </div>
          </section>

          <div className="mt-8 grid gap-8 md:grid-cols-[1fr_240px]">
            <div className="space-y-8">
              {cats.seo && (
                <section aria-labelledby="seo-h">
                  <h2 id="seo-h" className="text-xl font-medium">Search basics</h2>
                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="text-dim">
                        <tr>
                          <th scope="col" className="py-2 pr-4 font-normal">Check</th>
                          <th scope="col" className="py-2 pr-4 font-normal">Result</th>
                          <th scope="col" className="py-2 font-normal">Evidence</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cats.seo.checks.map((c) => (
                          <tr key={c.id} className="border-t border-line align-top">
                            <td className="py-2 pr-4">{c.label}</td>
                            <td className="py-2 pr-4"><StatusBadge status={c.result} /></td>
                            <td className="py-2 text-muted">{c.detail}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
              <AuditList title="Speed details" summary={cats.performance} />
              <AuditList title="Accessibility issues" summary={cats.accessibility} />
            </div>
            {shot && (
              <figure className="rounded border border-line p-2">
                <img src={shot} alt={`First screen of ${audit.final_url ?? audit.input_url} on a phone`} className="w-full rounded" />
                <figcaption className="mt-2 font-mono text-xs uppercase tracking-wider text-dim">First mobile screen</figcaption>
              </figure>
            )}
          </div>
        </>
      )}
    </main>
  );
}

function CategoryCard({ title, summary, reason }: { title: string; summary: PageSpeedSummary | undefined; reason: string | null | undefined }) {
  return (
    <div className="rounded border border-line bg-surface p-4">
      <h2 className="font-mono text-xs uppercase tracking-wider text-dim">{title}</h2>
      <p className="mt-2 font-mono text-4xl">{summary ? summary.score : '—'}</p>
      {!summary && <p className="mt-1 text-sm text-muted">Not measured: {errorCopy(reason ?? 'pagespeed_failed').message}</p>}
    </div>
  );
}

function AuditList({ title, summary }: { title: string; summary: PageSpeedSummary | undefined }) {
  if (!summary || summary.audits.length === 0) return null;
  return (
    <section>
      <h2 className="text-xl font-medium">{title}</h2>
      <ul className="mt-3 space-y-1 text-sm">
        {summary.audits.map((a) => (
          <li key={a.id} className="flex justify-between gap-4 border-t border-line py-2">
            <span>{a.title}</span>
            <span className="shrink-0 font-mono text-muted">{a.displayValue ?? (a.score === null ? '' : `${Math.round(a.score * 100)}`)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
