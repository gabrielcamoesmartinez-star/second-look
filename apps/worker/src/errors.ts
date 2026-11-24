import type { ErrorCode } from '@second-look/shared';

/** An error we expect and can explain to the user. Anything else becomes internal_error. */
export class AuditError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message?: string,
    public readonly retryable = false,
  ) {
    super(message ?? code);
    this.name = 'AuditError';
  }
}

export function toAuditError(err: unknown): AuditError {
  if (err instanceof AuditError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new AuditError('internal_error', message);
}
