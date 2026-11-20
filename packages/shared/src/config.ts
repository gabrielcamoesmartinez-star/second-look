/** Non-secret product constants shared by web, worker and functions. */
export const BOT_USER_AGENT_NAME = 'SecondLookBot';
export const BOT_VERSION = '1.0';
export function botUserAgent(publicOrigin: string): string {
  return `${BOT_USER_AGENT_NAME}/${BOT_VERSION} (+${publicOrigin.replace(/\/$/, '')}/bot)`;
}

export const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;
export const DESKTOP_VIEWPORT = { width: 1280, height: 800 } as const;
export const NAV_TIMEOUT_MS = 30_000;
export const MAX_PAGE_BYTES = 10 * 1024 * 1024;
export const MAX_REDIRECTS = 5;

export const DEFAULT_AUDITS_PER_USER_PER_DAY = 3;
export const DEFAULT_AUDITS_PER_IP_PER_DAY = 10;

export const JOB_POLL_INTERVAL_MS = 2_000;
export const JOB_HEARTBEAT_INTERVAL_MS = 15_000;
export const JOB_STALE_AFTER_SECONDS = 120;
export const MAX_CONCURRENT_JOBS = 2;
