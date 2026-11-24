import { AuditRow, errorCopy, normalizeUrl, type AuditStatus } from '@second-look/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { createAudit } from '../lib/api';
import { supabase } from '../lib/supabase';

const statusCls: Record<AuditStatus, string> = {
  queued: 'text-link',
  running: 'text-link',
  complete: 'text-pass',
  partial: 'text-warn',
  failed: 'text-fail',
  cancelled: 'text-muted',
};

export function AuditForm() {
  const navigate = useNavigate();
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const local = normalizeUrl(url);
    if (!local.ok) return setError(errorCopy(local.code));
    if (local.addedScheme) setNotice(`We added https:// — auditing ${local.url}`);
    setBusy(true);
    const res = await createAudit(local.url);
    setBusy(false);
    if (!res.ok) return setError(res.message);
    navigate(`/audits/${res.auditId}`);
  };

  return (
    <form onSubmit={submit} noValidate className="rounded-2xl border border-line bg-surface p-6">
      <label htmlFor="url" className="text-sm font-semibold">Website address</label>
      <div className="mt-2 flex flex-wrap gap-3">
        <input
          id="url"
          type="text"
          inputMode="url"
          autoComplete="url"
          placeholder="example-business.pt"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'url-error' : notice ? 'url-notice' : undefined}
          className="h-12 min-w-0 flex-[999_1_320px] rounded-lg border border-white/25 bg-surface-2 px-4 font-mono text-white"
        />
        <button
          type="submit"
          disabled={busy || !url.trim()}
          aria-busy={busy}
          className="h-12 flex-[0_0_auto] rounded-md bg-gradient-to-b from-white via-[#e7e7e7] to-[#cfcfcf] px-6 font-medium text-[#111] disabled:opacity-60"
        >
          {busy ? 'Starting…' : 'Run audit'}
        </button>
      </div>
      {error && <p id="url-error" role="alert" className="mt-3 text-sm text-fail">{error}</p>}
      {notice && !error && <p id="url-notice" className="mt-3 text-sm text-muted">{notice}</p>}
      <p className="mt-3 text-sm text-muted">Public pages only. We respect robots.txt. Usually under a minute.</p>
    </form>
  );
}

export function Audits() {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  useEffect(() => {
    void supabase
      .from('audits')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50)
      .then(({ data, error }) => {
        if (error) return setLoadError(true);
        const parsed = AuditRow.array().safeParse(data);
        if (parsed.success) setRows(parsed.data);
        else setLoadError(true);
      });
  }, []);

  return (
    <div className="space-y-10">
      <section>
        <h1 className="mb-6 text-4xl font-medium tracking-[-0.045em]">Where is this site losing enquiries?</h1>
        <AuditForm />
      </section>
      <section aria-labelledby="history">
        <h2 id="history" className="mb-4 text-2xl font-medium tracking-[-0.03em]">Your audits</h2>
        {loadError && <p role="alert" className="text-fail">Could not load your audits. Refresh to try again.</p>}
        {!rows && !loadError && <p className="text-muted" aria-busy="true">Loading…</p>}
        {rows?.length === 0 && <p className="text-muted">No audits yet. Paste a website above to run your first one.</p>}
        {rows && rows.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-line bg-surface">
            <table className="w-full min-w-[600px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wider text-muted">
                <tr>
                  <th scope="col" className="px-5 py-3">Site</th>
                  <th scope="col" className="px-5 py-3">Run</th>
                  <th scope="col" className="px-5 py-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-white/5">
                    <td className="px-5 py-3 font-mono">
                      <Link to={`/audits/${r.id}`}>{r.input_url.replace(/^https?:\/\//, '')}</Link>
                    </td>
                    <td className="px-5 py-3 text-muted">{new Date(r.created_at).toLocaleString()}</td>
                    <td className="px-5 py-3">
                      <span className={`font-semibold capitalize ${statusCls[r.status]}`}>{r.status}</span>
                      {(r.status === 'failed' || r.status === 'partial') && r.error_code && (
                        <span className="block text-xs text-muted">{errorCopy(r.error_code)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
