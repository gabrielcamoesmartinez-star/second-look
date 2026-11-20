import type { Logger } from './ports.ts';

/** Structured JSON logs, one object per line, always carrying bound fields such as audit_id. */
export function createLogger(base: Record<string, unknown> = {}, sink: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): Logger {
  const emit = (level: string, msg: string, fields?: Record<string, unknown>) =>
    sink(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...base, ...fields }));
  return {
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (f) => createLogger({ ...base, ...f }, sink),
  };
}

export const silentLogger: Logger = createLogger({}, () => {});
