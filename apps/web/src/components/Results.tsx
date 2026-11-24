import type { AuditRow, LighthouseCategoryResult, SeoResult } from '@second-look/shared';
import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

const resultCls = { pass: 'text-pass', warn: 'text-warn', fail: 'text-fail' } as const;
const resultLabel = { pass: 'Pass', warn: 'Improve', fail: 'Fail' } as const;

function ScoreCard({ title, score, note }: { title: string; score: number | null; note: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-5">
      <p className="font-mono text-xs uppercase tracking-[0.06em] text-dim">{title}</p>
      <p className="mt-2 text-4xl font-semibold tracking-tight">{score ?? '—'}</p>
      <p className="mt-1 text-sm text-muted">{note}</p>
    </div>
  );
}

function Lighthouse({ title, data }: { title: string; data: LighthouseCategoryResult }) {
  return (
    <section className="rounded-xl border border-line bg-surface p-5">
      <h3 className="font-medium">{title}</h3>
      {Object.keys(data.metrics).length > 0 && (
        <dl className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
          {Object.entries(data.metrics).map(([k, v]) => (
            <div key={k}>
              <dt className="text-muted">{k}</dt>
              <dd className="font-mono">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {data.topIssues.length > 0 ? (
        <ul className="mt-3 list-disc pl-5 text-sm text-[#C8C8C8]">
          {data.topIssues.map((i) => (
            <li key={i.id}>
              {i.title}
              {i.displayValue ? <span className="font-mono text-muted"> · {i.displayValue}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted">No significant issues found.</p>
      )}
    </section>
  );
}

function Seo({ data }: { data: SeoResult }) {
  return (
    <section className="overflow-x-auto rounded-xl border border-line bg-surface">
      <table className="w-full min-w-[560px] text-left text-sm">
        <caption className="px-5 pt-4 text-left font-medium">Local SEO checks</caption>
        <thead className="text-xs uppercase tracking-wider text-muted">
          <tr>
            <th scope="col" className="px-5 py-3">Check</th>
            <th scope="col" className="px-5 py-3">Result</th>
            <th scope="col" className="px-5 py-3">What we found</th>
          </tr>
        </thead>
        <tbody>
          {data.checks.map((c) => (
            <tr key={c.id} className="border-t border-white/5">
              <td className="px-5 py-3">{c.label}</td>
              <td className={`px-5 py-3 font-semibold ${resultCls[c.result]}`}>{resultLabel[c.result]}</td>
              <td className="px-5 py-3 text-[#C8C8C8]">{c.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function Results({ audit }: { audit: AuditRow }) {
  const [shot, setShot] = useState<string | null>(null);
  useEffect(() => {
    if (!audit.screenshot_path) return;
    void supabase.storage
      .from('audit-artifacts')
      .createSignedUrl(audit.screenshot_path, 3600)
      .then(({ data }) => setShot(data?.signedUrl ?? null));
  }, [audit.screenshot_path]);

  const c = audit.category_scores;
  return (
    <div className="mt-8 space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <ScoreCard title="Performance (mobile)" score={c?.performance?.score ?? null} note={c?.performance ? 'From Lighthouse' : 'Not measured'} />
        <ScoreCard title="Accessibility" score={c?.accessibility?.score ?? null} note={c?.accessibility ? 'From Lighthouse' : 'Not measured'} />
        <ScoreCard title="Local SEO" score={c?.seo?.score ?? null} note={c?.seo ? `${c.seo.checks.length} rule-based checks` : 'Not measured'} />
      </div>
      <div className="flex flex-wrap items-start gap-6">
        {shot && (
          <figure className="m-0">
            <img src={shot} alt={`First mobile screen of ${audit.final_url ?? audit.input_url}`} width={195} className="rounded-[28px] border-[6px] border-[#2A2A2E]" />
            <figcaption className="mt-2 font-mono text-xs text-dim">FIRST SCREEN · 390 PX</figcaption>
          </figure>
        )}
        <div className="min-w-0 flex-1 space-y-4">
          {c?.performance && <Lighthouse title="Performance" data={c.performance} />}
          {c?.accessibility && <Lighthouse title="Accessibility" data={c.accessibility} />}
        </div>
      </div>
      {c?.seo && <Seo data={c.seo} />}
    </div>
  );
}
