import type { AccessRole } from '../types/access';

/** Shown when a *member* tries to create issues, PRDs, tickets, or assign work. */
export const MEMBER_WRITE_DENIED_MESSAGE =
  'You’re on the *Member* plan for MrSoul — you can ask things like *who’s working on what* or team status, but you can’t create issues, PRDs, `/create-ticket`, or assign work.\n\n' +
  'Need to file work? Ask a *Tech Admin* to upgrade you to *Admin* in the admin portal or via `@MrSoul grant access your@email admin`.';

export function canPerformWrites(role: AccessRole | undefined, accessControlEnabled: boolean): boolean {
  if (!accessControlEnabled) return true;
  return role === 'admin' || role === 'super_admin';
}

export function canPerformReads(_role: AccessRole | undefined, accessControlEnabled: boolean): boolean {
  if (!accessControlEnabled) return true;
  return true;
}

export function formatRoleCapabilities(role: AccessRole): string {
  switch (role) {
    case 'super_admin':
      return 'Full access: questions, create issues & PRDs, `/create-ticket`, assign work, grant/revoke access.';
    case 'admin':
      return 'Full product access: questions, create issues & PRDs, `/create-ticket`, assign work, grant access to others.';
    default:
      return 'Read & ask: workload, team status, how things work. Cannot create issues, PRDs, tickets, or assign work.';
  }
}
