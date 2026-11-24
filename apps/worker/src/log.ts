type Level = 'debug' | 'info' | 'warn' | 'error';

/** Structured JSON logs, one line per event, always tagged with audit_id when there is one. */
export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (process.env.NODE_ENV === 'test' && level !== 'error') return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}
