import { parseExplicitGithubLogin } from '../services/developerMatch';

/** Normalize common typos in raise-ticket messages. */
export function normalizeRaiseTicketText(text: string): string {
  return text
    .trim()
    .replace(/\briase\b/gi, 'raise')
    .replace(/\braise\s+this\s+ticket\s+for\b/gi, 'raise this ticket to')
    .replace(/\braise\s+ticket\s+for\b/gi, 'raise ticket to');
}

/** Parse "Good to go raise this ticket to Akriti" / assignee hints. */
export function parseRaiseTicketAssignee(text: string): string | null {
  const normalized = normalizeRaiseTicketText(text);

  // "Good to go … tss-devanshsaxena" (with or without "raise", colons optional)
  const explicit = parseExplicitGithubLogin(normalized);
  if (
    explicit &&
    /\b(good\s+to\s+go|raise|assign|create|ticket|issue)\b/i.test(normalized)
  ) {
    return explicit;
  }

  const patterns = [
    /\bgood\s+to\s+go\b[^.!\n]*?\braise\s+(?:this\s+)?ticket\s+to\s*:?\s*(.+)$/i,
    /\bgood\s+to\s+go\b[^.!\n]*?\bto\s*:?\s*(.+)$/i,
    /\braise\s+(?:this\s+)?ticket\s+to\s*:?\s*(.+)$/i,
    /\braise\s+(?:this\s+)?ticket\s+(?:for|with)\s*:?\s*(.+)$/i,
    /\bassign\s+(?:to|this\s+to)\s*:?\s*(.+)$/i,
    /\bcreate\s+(?:the\s+)?(?:github\s+)?issue\s+(?:for|to)\s*:?\s*(.+)$/i,
  ];

  for (const re of patterns) {
    const m = normalized.match(re);
    if (m?.[1]) {
      let candidate = m[1].replace(/[.!?]+$/, '').trim();
      const embeddedLogin = parseExplicitGithubLogin(candidate);
      if (embeddedLogin) return embeddedLogin;
      if (candidate.length >= 2) return candidate;
    }
  }

  // Bare "tss-*" when message clearly intends to assign
  if (explicit && /\b(to|for|assign)\b/i.test(normalized)) {
    return explicit;
  }

  return null;
}

export function looksLikeRaiseAttempt(text: string): boolean {
  const t = normalizeRaiseTicketText(text).toLowerCase();
  return (
    /\b(good\s+to\s+go|raise|assign|tss-)\b/.test(t) &&
    (/\bticket\b/.test(t) || /\btss-/.test(t) || /\bto\s*:/.test(t) || /\bto\s+\w/.test(t))
  );
}

export function isTicketApproval(text: string): boolean {
  const t = text.trim().toLowerCase();
  // "Good to go raise…" is not an approval — it's assignee intent
  if (looksLikeRaiseAttempt(text)) return false;
  if (/^(approve|approved|lgtm|looks good|yes|go ahead|proceed)\b/.test(t)) return true;
  if (/\b(approve|approved)\b/.test(t) && t.length < 80) return true;
  return false;
}

export function isTicketRejection(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (looksLikeRaiseAttempt(text)) return false;
  if (/^(reject|rejected|cancel|cancelled|no|stop|discard)\b/.test(t)) return true;
  if (/\b(reject|cancel)\b/.test(t) && t.length < 60) return true;
  return false;
}

export function isRevisionComment(text: string): boolean {
  const t = text.trim();
  if (isTicketApproval(t) || isTicketRejection(t)) return false;
  if (parseRaiseTicketAssignee(t)) return false;
  return t.length >= 3;
}
