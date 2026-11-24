// GENERATED from packages/shared/src/errors.ts by scripts/sync-edge-shared.mjs. Do not edit.
/** Every failure the user can see has a code here and plain-language copy with an action. */
export const ERROR_CODES = [
  'invalid_url',
  'ssrf_blocked',
  'blocked_by_robots',
  'fetch_timeout',
  'fetch_failed',
  'http_error',
  'page_too_large',
  'quota_exceeded',
  'rate_limited',
  'not_authenticated',
  'pagespeed_failed',
  'ai_budget_reached',
  'cancelled',
  'internal_error',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_COPY: Record<ErrorCode, string> = {
  invalid_url: "That doesn't look like a website address. Check it and try again.",
  ssrf_blocked: "That address isn't a public website, so we can't audit it.",
  blocked_by_robots: "This site asks crawlers not to visit, so we can't audit it.",
  fetch_timeout: 'The site took too long to respond. Try again in a few minutes.',
  fetch_failed: "We couldn't reach that site. Check the address, or try again later.",
  http_error: 'The site returned an error page instead of its home page.',
  page_too_large: 'That page is too large for us to audit.',
  quota_exceeded: "You've used today's audits. Try again tomorrow.",
  rate_limited: 'Too many audits from this connection. Try again later.',
  not_authenticated: 'Sign in to run an audit.',
  pagespeed_failed: "Google's speed test didn't respond, so speed and accessibility weren't measured.",
  ai_budget_reached: 'The AI checks are paused for today; the other checks still ran.',
  cancelled: 'This audit was cancelled.',
  internal_error: 'Something went wrong on our side. Try again; if it keeps happening, let us know.',
};

export function errorCopy(code: string | null | undefined): string {
  if (code && (ERROR_CODES as readonly string[]).includes(code)) return ERROR_COPY[code as ErrorCode];
  return ERROR_COPY.internal_error;
}
