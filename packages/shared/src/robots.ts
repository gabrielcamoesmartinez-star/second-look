/** Minimal robots.txt support (RFC 9309): user-agent groups, Allow/Disallow, * and $ patterns. */

interface Rule {
  allow: boolean;
  pattern: string;
}

interface Group {
  agents: string[];
  rules: Rule[];
}

export function parseRobots(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === 'allow' || key === 'disallow') && current) {
      lastWasAgent = false;
      if (key === 'disallow' && value === '') continue; // empty Disallow allows everything
      current.rules.push({ allow: key === 'allow', pattern: value });
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp('^' + body + (anchored ? '$' : ''));
}

/** Returns true if `userAgent` may fetch `path` (path + query). The product token is matched case-insensitively. */
export function isAllowedByRobots(robotsTxt: string, userAgent: string, path: string): boolean {
  const groups = parseRobots(robotsTxt);
  const token = userAgent.toLowerCase().split('/')[0] ?? '';
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && token.startsWith(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  if (!chosen.length) return true;
  const rules = chosen.flatMap((g) => g.rules);
  let best: Rule | null = null;
  for (const r of rules) {
    if (!patternToRegex(r.pattern).test(path)) continue;
    if (
      !best ||
      r.pattern.length > best.pattern.length ||
      (r.pattern.length === best.pattern.length && r.allow && !best.allow)
    )
      best = r;
  }
  return best ? best.allow : true;
}
