import { errorCopy, type AuditRow } from '@second-look/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { createAudit, listAudits, quotaRemaining, TERMINAL } from '../lib/api.ts';
import { AUDITS_PER_USER_PER_DAY } from '../lib/supabase.ts';
import { urlHint } from '../lib/urlHint.ts';

export function Audits() {
  const navigate = useNavigate();
  const [url, setUrl] = useState('');
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [audits, setAudits] = useState<AuditRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    listAudits().then(setAudits, (e: Error) => setLoadError(e.message));
    quotaRemaining(AUDITS_PER_USER_PER_DAY).then(setRemaining, () => setRemaining(null));
  }, []);

  const hint = urlHint(url);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!hint.valid) return;
    setSubmitting(true);
    setServerError(null);
    const res = await createAudit(url);
    setSubmitting(false);
    if (res.ok) navigate(`/audits/${res.auditId}/running`);
    else setServerError(res.message);
  }

  return (
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="text-3xl font-medium tracking-tight">Audits</h1>

      <form onSubmit={onSubmit} className="mt-6 rounded border border-line bg-surface p-4" noValidate>
        <label htmlFor="url" className="block text-sm text-muted">Website address</label>
        <div className="mt-2 flex flex-wrap gap-2">
          <input
            id="url"
            inputMode="url"
            autoComplete="url"
            placeholder="examplebakery.pt"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onBlur={() => setTouched(true)}
            aria-invalid={touched && !hint.valid && url !== ''}
            aria-describedby="url-hint url-quota"
            className="min-w-0 flex-1 rounded border border-line bg-black px-3 py-2 font-mono"
          />
          <button
            type="submit"
            disabled={submitting || remaining === 0}
            aria-busy={submitting}
            className="rounded bg-white px-4 py-2 font-medium text-black disabled:opacity-50"
          >
            {submitting ? 'Starting…' : 'Run audit'}
          </button>
        </div>
        <p id="url-hint" className={`mt-2 text-sm ${touched && !hint.valid && url !== '' ? 'text-fail' : 'text-muted'}`} aria-live="polite">
          {touched && !hint.valid && url !== '' ? "That doesn't look like a website address." : hint.message}
        </p>
        <p id="url-quota" className="mt-1 font-mono text-xs uppercase tracking-wider text-dim">
          {remaining === null ? '' : `${remaining} of ${AUDITS_PER_USER_PER_DAY} audits left today`}
        </p>
        {serverError && <p role="alert" className="mt-2 text-fail">{serverError}</p>}
      </form>

      <section className="mt-10" aria-labelledby="history">
        <h2 id="history" className="text-xl font-medium">History</h2>
        {loadError && <p role="alert" className="mt-4 text-fail">Couldn't load your audits. {loadError}</p>}
        {audits === null && !loadError && <p aria-busy="true" className="mt-4 text-muted">Loading…</p>}
        {audits?.length === 0 && <p className="mt-4 text-muted">No audits yet. Paste a website above to run your first one.</p>}
        {audits && audits.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-dim">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-normal">Site</th>
                  <th scope="col" className="py-2 pr-4 font-normal">Status</th>
                  <th scope="col" className="py-2 pr-4 font-normal">When</th>
                  <th scope="col" className="py-2 font-normal">Note</th>
                </tr>
              </thead>
              <tbody>
                {audits.map((a) => (
                  <tr key={a.id} className="border-t border-line">
                    <td className="py-2 pr-4 font-mono">
                      <Link className="text-link underline" to={TERMINAL.has(a.status) ? `/audits/${a.id}` : `/audits/${a.id}/running`}>
                        {a.input_url.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                      </Link>
                    </td>
                    <td className="py-2 pr-4"><StatusBadge status={a.status} /></td>
                    <td className="py-2 pr-4 font-mono text-muted">{new Date(a.created_at).toLocaleString()}</td>
                    <td className="py-2 text-muted">{a.error_code ? errorCopy(a.error_code).message : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
