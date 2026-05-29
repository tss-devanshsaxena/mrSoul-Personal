export type AccessRole = 'super_admin' | 'admin' | 'member';

export interface AccessCheckResult {
  allowed: boolean;
  role?: AccessRole;
  email?: string;
  reason?: string;
}
