import { describe, expect, it } from 'vitest';
import { isAllowedByRobots } from '../src/robots';

const UA = 'SecondLookBot/1.0 (+https://secondlook.example/bot)';

describe('isAllowedByRobots', () => {
  it('allows everything with an empty file', () => expect(isAllowedByRobots('', UA, '/')).toBe(true));
  it('blocks a full disallow for *', () => expect(isAllowedByRobots('User-agent: *\nDisallow: /', UA, '/')).toBe(false));
  it('prefers our specific group over *', () => {
    const txt = 'User-agent: *\nDisallow: /\n\nUser-agent: SecondLookBot\nAllow: /';
    expect(isAllowedByRobots(txt, UA, '/')).toBe(true);
  });
  it('uses the longest matching rule', () => {
    const txt = 'User-agent: *\nDisallow: /private\nAllow: /private/ok';
    expect(isAllowedByRobots(txt, UA, '/private/ok/page')).toBe(true);
    expect(isAllowedByRobots(txt, UA, '/private/no')).toBe(false);
    expect(isAllowedByRobots(txt, UA, '/')).toBe(true);
  });
  it('supports * and $', () => {
    const txt = 'User-agent: *\nDisallow: /*.pdf$';
    expect(isAllowedByRobots(txt, UA, '/menu.pdf')).toBe(false);
    expect(isAllowedByRobots(txt, UA, '/menu.pdf?x=1')).toBe(true);
  });
  it('treats empty Disallow as allow-all', () => expect(isAllowedByRobots('User-agent: *\nDisallow:', UA, '/')).toBe(true));
  it('handles grouped user-agents and comments', () => {
    const txt = '# hi\nUser-agent: Googlebot\nUser-agent: SecondLookBot # us\nDisallow: /\n';
    expect(isAllowedByRobots(txt, UA, '/')).toBe(false);
  });
});
