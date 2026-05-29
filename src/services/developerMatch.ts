export interface DeveloperProfile {
  githubUsername: string;
  displayName: string;
  slackUserId?: string;
  domains: string[];
}

export type DeveloperMatchResult =
  | { status: 'matched'; profile: DeveloperProfile }
  | { status: 'ambiguous'; matches: DeveloperProfile[]; query: string }
  | { status: 'not_found'; suggestions: DeveloperProfile[]; query: string };

export function normalizeToken(s: string): string {
  return s.toLowerCase().replace(/^tss-/, '').replace(/[^a-z0-9]/g, '');
}

export function parseExplicitGithubLogin(query: string): string | null {
  const trimmed = query.trim().toLowerCase();
  const direct = trimmed.match(/^(tss-[a-z0-9](?:[a-z0-9-]*)?)$/);
  if (direct) return direct[1];

  const embedded = trimmed.match(/\b(tss-[a-z0-9](?:[a-z0-9-]*)?)\b/);
  return embedded?.[1] ?? null;
}

function scoreDeveloper(query: string, profile: DeveloperProfile): number {
  const q = normalizeToken(query);
  if (!q || q.length < 2) return 0;

  const parts = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(w => !['the', 'dev', 'developer', 'is'].includes(w));
  const firstName = normalizeToken(parts[0] ?? q);
  const fullNameNorm = normalizeToken(parts.join(''));

  const loginBody = normalizeToken(profile.githubUsername);
  const displayNorm = normalizeToken(profile.displayName);
  const nameParts = profile.displayName.split(/\s+/).map(normalizeToken).filter(Boolean);

  let score = 0;

  if (loginBody === q || displayNorm === q) score = 100;
  else if (nameParts.some(n => n === q || n === firstName)) score = 96;
  else if (fullNameNorm.length >= 4 && loginBody.includes(fullNameNorm)) {
    score = 98;
  } else if (fullNameNorm.length >= 4 && displayNorm.includes(fullNameNorm) && !loginBody.includes(fullNameNorm)) {
    // Display says "Devansh Saxena" but login is different — weaker than login match
    score = 72;
  } else if (loginBody.startsWith(q) && q.length >= 4) score = 92;
  else if (firstName.length >= 3 && loginBody.startsWith(firstName)) score = 90;
  else if (nameParts.some(n => n.startsWith(q) || q.startsWith(n))) score = 85;
  else if (loginBody.includes(q) || displayNorm.includes(q)) score = 65;
  else if (firstName.length >= 3 && loginBody.includes(firstName)) score = 82;

  if (parts.length >= 2) {
    const surname = normalizeToken(parts[parts.length - 1] ?? '');
    if (surname.length >= 4 && loginBody.includes(surname)) {
      score = Math.max(score, 97);
    }
  }

  return score;
}

/**
 * Match a human name or `tss-*` login to one developer; disambiguate when several match.
 */
export function matchDevelopers(
  query: string,
  directory: DeveloperProfile[],
  displayFromGithub: (login: string) => string
): DeveloperMatchResult {
  const trimmed = query.trim();
  if (!trimmed) {
    return { status: 'not_found', suggestions: [], query: trimmed };
  }

  const explicit = parseExplicitGithubLogin(trimmed);
  if (explicit) {
    const found = directory.find(p => p.githubUsername === explicit);
    return {
      status: 'matched',
      profile:
        found ?? {
          githubUsername: explicit,
          displayName: displayFromGithub(explicit),
          domains: [],
        },
    };
  }

  const scored = directory
    .map(profile => ({ profile, score: scoreDeveloper(trimmed, profile) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    const q = normalizeToken(trimmed);
    const suggestions = directory
      .filter(p => {
        const login = normalizeToken(p.githubUsername);
        const display = normalizeToken(p.displayName);
        return login.includes(q.slice(0, 3)) || display.includes(q.slice(0, 3));
      })
      .slice(0, 6);
    return { status: 'not_found', suggestions, query: trimmed };
  }

  const topScore = scored[0].score;
  const close = scored.filter(s => s.score >= Math.max(80, topScore - 8));

  const byLogin = new Map<string, (typeof scored)[0]>();
  for (const s of close) {
    const cur = byLogin.get(s.profile.githubUsername);
    if (!cur || s.score > cur.score) byLogin.set(s.profile.githubUsername, s);
  }
  const unique = [...byLogin.values()];

  if (unique.length > 1) {
    const disambiguated = disambiguateByNameParts(trimmed, unique.map(u => u.profile));
    if (disambiguated) {
      return { status: 'matched', profile: disambiguated };
    }
    return {
      status: 'ambiguous',
      matches: unique.map(u => u.profile),
      query: trimmed,
    };
  }

  return { status: 'matched', profile: unique[0].profile };
}

/**
 * When several developers score closely (e.g. two "Devansh" logins), prefer the
 * profile whose GitHub login contains the surname / extra name tokens.
 */
export function disambiguateByNameParts(
  query: string,
  candidates: DeveloperProfile[]
): DeveloperProfile | null {
  const parts = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length >= 3 && !['the', 'dev', 'developer', 'tss'].includes(w));

  if (parts.length < 2 || candidates.length < 2) return null;

  const scored = candidates.map(profile => {
    const login = normalizeToken(profile.githubUsername);
    const display = normalizeToken(profile.displayName);
    let score = 0;
    for (const part of parts) {
      const p = normalizeToken(part);
      if (login.includes(p)) score += 3;
      else if (display.includes(p)) score += 1;
    }
    return { profile, score };
  });

  const best = scored.sort((a, b) => b.score - a.score)[0];
  const second = scored[1];
  if (!best || best.score < 3) return null;
  if (second && best.score === second.score) return null;
  return best.profile;
}
