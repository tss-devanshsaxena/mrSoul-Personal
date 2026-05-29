import type { AccessRole } from '../types/access';

export type AccessAdminCommand =
  | { kind: 'grant'; email: string; role: AccessRole }
  | { kind: 'revoke'; email: string }
  | { kind: 'list' }
  | { kind: 'my_access' };

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function parseAccessAdminCommand(text: string): AccessAdminCommand | null {
  const t = text.trim();
  const lower = t.toLowerCase();

  if (/\b(my\s+access|who\s+am\s+i|access\s+status)\b/i.test(lower)) {
    return { kind: 'my_access' };
  }

  if (/\b(list\s+access|list\s+users|who\s+has\s+access)\b/i.test(lower)) {
    return { kind: 'list' };
  }

  const grantMatch = t.match(
    /\bgrant\s+access\s+(?:to\s+)?([^\s]+@[^\s]+)(?:\s+(super[_-]?admin|admin|member))?\s*$/i
  );
  if (grantMatch) {
    const roleRaw = (grantMatch[2] ?? 'member').toLowerCase().replace('-', '_');
    const role: AccessRole =
      roleRaw === 'super_admin' || roleRaw === 'superadmin'
        ? 'super_admin'
        : roleRaw === 'admin'
          ? 'admin'
          : 'member';
    return { kind: 'grant', email: normalizeEmail(grantMatch[1]), role };
  }

  const revokeMatch = t.match(
    /\b(?:revoke|remove|delete)\s+access\s+(?:from\s+|for\s+)?([^\s]+@[^\s]+)\s*$/i
  );
  if (revokeMatch) {
    return { kind: 'revoke', email: normalizeEmail(revokeMatch[1]) };
  }

  return null;
}

export function extractEmailFromText(text: string): string | null {
  const m = text.match(EMAIL_RE);
  return m ? normalizeEmail(m[0]) : null;
}

export function isAccessAdminCommand(text: string): boolean {
  return parseAccessAdminCommand(text) !== null;
}
