const STYLES: Record<string, string> = {
  complete: 'text-pass border-pass/40',
  done: 'text-pass border-pass/40',
  pass: 'text-pass border-pass/40',
  partial: 'text-warn border-warn/40',
  retrying: 'text-warn border-warn/40',
  running: 'text-link border-link/40',
  queued: 'text-muted border-line',
  skipped: 'text-muted border-line border-dashed',
  failed: 'text-fail border-fail/40',
  fail: 'text-fail border-fail/40',
  cancelled: 'text-muted border-line',
};

/** Colour is never the only signal: the label is always shown. */
export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-block rounded border px-2 py-0.5 font-mono text-xs uppercase tracking-wider ${STYLES[status] ?? 'text-muted border-line'}`}>
      {status}
    </span>
  );
}
