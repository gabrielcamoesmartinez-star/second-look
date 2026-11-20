import { normaliseUrl } from '@second-look/shared';

/** Inline validation for the URL field. The server re-validates everything. */
export function urlHint(input: string): { valid: boolean; message: string | null; normalised: string | null } {
  if (input.trim() === '') return { valid: false, message: null, normalised: null };
  const r = normaliseUrl(input);
  if (!r.ok) return { valid: false, message: "That doesn't look like a website address.", normalised: null };
  return { valid: true, message: r.addedScheme ? `We'll check ${r.url}` : null, normalised: r.url };
}
