import {
  CATEGORY_LABELS,
  checkById,
  CheckId,
  CONFIDENCE_THRESHOLD,
  errorCopy,
  type CheckResultRow,
  type FixRow,
  type PageSpeedSummary,
  type ScoreCategory,
} from '@second-look/shared';
import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { createAudit, getChecksAndFixes, signedArtifactUrl, TERMINAL } from '../lib/api.ts';
import { useLiveAudit } from '../lib/useAudit.ts';

/** Stage 2 report with plain styling. The designed version (Gauge, AnnotatedScreenshot, sticky bar) is Stage 4. */
export function Report() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const { audit, steps, loading, error } = useLiveAudit(id);
  const [shot, setShot] = useState<string | null>(null);
  const [checks, setChecks] = useState<CheckResultRow[]>([]);
  const [fixes, setFixes] = useState<FixRow[]>([]);
  const navigate = useNavigate();
  const [rerun, setRerun] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  async function onRerun(url: string) {
    setRerun({ busy: true, error: null });
    const res = await createAudit(url, true);
    if (res.ok) navigate(`/audits/${res.auditId}/running`);
    else setRerun({ busy: false, error: res.message });
  }

  useEffect(() => {
    if (audit?.screenshot_path) void signedArtifactUrl(audit.screenshot_path).then(setShot);
  }, [audit?.screenshot_path]);
  useEffect(() => {
    if (audit && TERMINAL.has(audit.status)) {
      void getChecksAndFixes(id).then(({ checks, fixes }) => {
        setChecks(checks);
        setFixes(fixes);
      });
    }
  }, [id, audit?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <p aria-busy="true" className="p-8 text-muted">Loading report…</p>;
  if (error && !audit) return <p role="alert" className="p-8 text-fail">Couldn't load this report. {error}</p>;
  if (!audit) return <main className="p-8"><p>We couldn't find that audit.</p></main>;
  if (!TERMINAL.has(audit.status)) return <Navigate to={`/audits/${id}/running`} replace />;

  const cats = audit.category_scores ?? {};
  const breakdown = cats.breakdown;
  const copy = audit.error_code ? errorCopy(audit.error_code) : null;
  const stepErrors = steps.filter((s) => s.status === 'failed' && s.error_code && s.step !== 'fetch');
  // Normally only failed checks get numbered markers. ?markers=all also draws passing elements (for checking alignment).
  const showAll = params.get('markers') === 'all';
  const failedWithBox = checks.filter((c) => (showAll || c.result === 'fail') && c.box).sort(byCheckOrder);
  const sortedChecks = [...checks].sort(byCheckOrder);

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
        <div className="flex items-center gap-3">
          <StatusBadge status={audit.status} />
          <button
            type="button"
            onClick={() => void onRerun(audit.input_url)}
            disabled={rerun.busy}
            aria-busy={rerun.busy}
            className="rounded border border-line px-3 py-1.5 text-sm disabled:opacity-50"
          >
            {rerun.busy ? 'Starting…' : 'Re-run'}
          </button>
        </div>
      </header>
      {rerun.error && <p role="alert" className="mt-3 text-fail">{rerun.error}</p>}
      <p className="sr-only">Re-run starts a fresh audit and uses one of today's audits.</p>

      {params.get('cached') && (
        <p role="status" className="mt-4 rounded border border-line p-3 text-sm text-muted">
          You audited this address in the last 24 hours, so this is that result. No audit was used.
        </p>
      )}

      {copy && (
        <div role="alert" className="mt-6 rounded border border-fail/40 p-4">
          <p className="text-fail">{copy.message}</p>
          <p className="mt-1 text-muted">{copy.action}</p>
        </div>
      )}
      {audit.status === 'partial' && stepErrors.length > 0 && (
        <ul className="mt-6 space-y-1 rounded border border-warn/40 p-4 text-sm">
          {stepErrors.map((s) => (
            <li key={s.step} className="text-warn">{errorCopy(s.error_code).message}</li>
          ))}
        </ul>
      )}

      {audit.status !== 'failed' && (
        <>
          <section className="mt-8 grid gap-4 md:grid-cols-5" aria-label="Scores">
            <div className="rounded border border-line bg-surface p-4">
              <h2 className="font-mono text-xs uppercase tracking-wider text-dim">Overall</h2>
              <p className="mt-2 font-mono text-5xl" aria-label={`Overall score ${audit.score ?? 'not available'} out of 100`}>
                {audit.score ?? '—'}
              </p>
            </div>
            {(['enquiry', 'local_visibility', 'performance', 'accessibility'] as ScoreCategory[]).map((k) => {
              const c = breakdown?.categories[k];
              return (
                <div key={k} className="rounded border border-line bg-surface p-4">
                  <h2 className="font-mono text-xs uppercase tracking-wider text-dim">{CATEGORY_LABELS[k]}</h2>
                  <p className="mt-2 font-mono text-3xl">{c?.score ?? '—'}</p>
                  {c?.score === null || c === undefined ? (
                    <p className="mt-1 text-xs text-muted">Not measured{c?.reason ? `: ${c.reason}` : ''}</p>
                  ) : (
                    <p className="mt-1 font-mono text-xs text-dim">weight {Math.round(c.effectiveWeight * 100)}%</p>
                  )}
                </div>
              );
            })}
          </section>
          {breakdown && breakdown.missing.length > 0 && (
            <p className="mt-2 text-sm text-muted">
              {breakdown.missing.map((m) => CATEGORY_LABELS[m as ScoreCategory] ?? m).join(' and ')} couldn't be measured, so the overall score re-weights the other categories.
            </p>
          )}

          {audit.summary && (
            <section className="mt-10" aria-labelledby="plain-h">
              <h2 id="plain-h" className="text-xl font-medium">In plain English</h2>
              <div className="mt-3 max-w-prose space-y-3 text-muted">
                {audit.summary.split('\n\n').map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
              </div>
            </section>
          )}

          <div className="mt-10 grid gap-8 md:grid-cols-[280px_1fr]">
            <section aria-labelledby="saw-h">
              <h2 id="saw-h" className="text-xl font-medium">What the AI saw</h2>
              {shot ? (
                <figure
                  className="relative mt-3 overflow-hidden rounded-[36px] border-[6px] border-[#2A2A2E]"
                  role="img"
                  aria-label={
                    failedWithBox.length
                      ? `First mobile screen with ${failedWithBox.length} marked problem${failedWithBox.length === 1 ? '' : 's'}: ${failedWithBox.map((c, i) => `${i + 1}, ${nameOf(c.check_id)}`).join('; ')}`
                      : 'First mobile screen; no problems are marked on it'
                  }
                >
                  <img src={shot} alt="" className="block w-full" />
                  {failedWithBox.map((c, i) => (
                    <div
                      key={c.check_id}
                      className={`absolute border-2 border-dashed ${c.result === 'fail' ? 'border-fail' : 'border-pass'}`}
                      style={{ left: `${c.box!.x}%`, top: `${c.box!.y}%`, width: `${c.box!.w}%`, height: `${c.box!.h}%` }}
                    >
                      <span className="absolute -left-3 -top-3 flex h-[26px] w-[26px] items-center justify-center rounded-full bg-white font-mono text-xs text-black shadow-[0_0_12px_rgba(255,155,128,.6)]">
                        {i + 1}
                      </span>
                    </div>
                  ))}
                </figure>
              ) : (
                <p className="mt-3 text-muted">No screenshot.</p>
              )}
              {failedWithBox.length > 0 && (
                <ol className="mt-3 space-y-1 text-sm">
                  {failedWithBox.map((c, i) => (
                    <li key={c.check_id}>
                      <span className="font-mono">{i + 1}</span> · {nameOf(c.check_id)}
                      {showAll && <span className="ml-2"><StatusBadge status={c.result} /></span>}
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section aria-labelledby="fixes-h">
              <h2 id="fixes-h" className="text-xl font-medium">Fixes, most impact first</h2>
              {fixes.length === 0 ? (
                <p className="mt-3 text-muted">Nothing to fix from these checks.</p>
              ) : (
                <ol className="mt-3 space-y-3">
                  {fixes.map((f) => (
                    <li key={f.rank} id={`fix-${f.check_ids[0]}`} className="rounded border border-line bg-surface p-4">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <h3 className="font-medium"><span className="mr-2 font-mono text-dim">{f.rank}</span>{f.title}</h3>
                        <span className="font-mono text-xs uppercase tracking-wider text-dim">{f.impact} impact · effort {f.effort}/5</span>
                      </div>
                      <p className="mt-2 text-sm text-muted">{f.why}</p>
                      <p className="mt-2 text-sm"><span className="text-dim">Evidence: </span>{f.evidence}</p>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>

          <section className="mt-10" aria-labelledby="checks-h">
            <h2 id="checks-h" className="text-xl font-medium">Enquiry checklist</h2>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-dim">
                  <tr>
                    <th scope="col" className="py-2 pr-4 font-normal">Check</th>
                    <th scope="col" className="py-2 pr-4 font-normal">Result</th>
                    <th scope="col" className="py-2 pr-4 font-normal">Confidence</th>
                    <th scope="col" className="py-2 pr-4 font-normal">Evidence</th>
                    <th scope="col" className="py-2 font-normal">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedChecks.map((c) => (
                    <tr key={c.check_id} className="border-t border-line align-top">
                      <td className="py-2 pr-4">{nameOf(c.check_id)}</td>
                      <td className="py-2 pr-4"><StatusBadge status={c.confidence < CONFIDENCE_THRESHOLD && c.result !== 'unsure' ? 'unsure' : c.result} /></td>
                      <td className="py-2 pr-4 font-mono">{c.confidence.toFixed(2)}</td>
                      <td className="py-2 pr-4 text-muted">{c.evidence}</td>
                      <td className="py-2 font-mono text-xs uppercase text-dim">{c.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {cats.seo && (
            <section className="mt-10" aria-labelledby="seo-h">
              <h2 id="seo-h" className="text-xl font-medium">Search basics <span className="font-mono text-dim">{cats.seo.score}</span></h2>
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
        </>
      )}
    </main>
  );
}

const ORDER = CheckId.options;
function byCheckOrder(a: CheckResultRow, b: CheckResultRow): number {
  return ORDER.indexOf(a.check_id as CheckId) - ORDER.indexOf(b.check_id as CheckId);
}
function nameOf(id: string): string {
  const parsed = CheckId.safeParse(id);
  return parsed.success ? checkById(parsed.data).name : id;
}

function AuditList({ title, summary }: { title: string; summary: PageSpeedSummary | undefined }) {
  if (!summary || summary.audits.length === 0) return null;
  return (
    <section className="mt-10">
      <h2 className="text-xl font-medium">{title} <span className="font-mono text-dim">{summary.score}</span></h2>
      <ul className="mt-3 space-y-1 text-sm">
        {summary.audits.map((a) => (
          <li key={a.id} className="flex justify-between gap-4 border-t border-line py-2">
            <span>{a.title}</span>
            {/* Only show a value Google actually gave; binary audits have none. */}
            {a.displayValue && <span className="shrink-0 font-mono text-muted">{a.displayValue}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
