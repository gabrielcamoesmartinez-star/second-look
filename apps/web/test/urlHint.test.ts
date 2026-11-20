import { describe, expect, it } from 'vitest';
import { urlHint } from '../src/lib/urlHint.ts';

describe('urlHint', () => {
  it('is quiet for empty input', () => {
    expect(urlHint('')).toEqual({ valid: false, message: null, normalised: null });
  });
  it('tells the user when https:// is added', () => {
    expect(urlHint('bakery.pt')).toEqual({ valid: true, message: "We'll check https://bakery.pt/", normalised: 'https://bakery.pt/' });
  });
  it('flags invalid input with the shared copy', () => {
    expect(urlHint('not a url').message).toBe("That doesn't look like a website address.");
  });
});
