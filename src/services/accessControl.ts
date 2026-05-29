import { config } from '../config';
import { MrSoulAccessUser } from '../models';
import type { AccessRole, AccessCheckResult } from '../types/access';
import { normalizeEmail, type AccessAdminCommand } from '../utils/accessCommands';
import { formatRoleCapabilities, canPerformWrites } from '../permissions/accessPermissions';
import { createLogger } from '../utils/logger';

const log = createLogger('access-control');

/** Built-in seed — overridden only if email not already in DB with a role. */
const DEFAULT_ACCESS_SEED: Array<{ email: string; role: AccessRole }> = [
  { email: 'devansh.saxena@thesouledstore.com', role: 'super_admin' },
  { email: 'rahul.jaisheel@thesouledstore.com', role: 'admin' },
  { email: 'jaynam.mehta@thesouledstore.com', role: 'member' },
  { email: 'saif.khan@thesouledstore.com', role: 'member' },
];

const ROLE_RANK: Record<AccessRole, number> = {
  member: 1,
  admin: 2,
  super_admin: 3,
};

export class AccessControlService {
  private static instance: AccessControlService;

  static getInstance(): AccessControlService {
    if (!AccessControlService.instance) {
      AccessControlService.instance = new AccessControlService();
    }
    return AccessControlService.instance;
  }

  isEnabled(): boolean {
    return config.accessControl.enabled;
  }

  async seedDefaults(): Promise<void> {
    if (!this.isEnabled()) return;

    for (const { email, role } of DEFAULT_ACCESS_SEED) {
      const normalized = normalizeEmail(email);
      await MrSoulAccessUser.findOneAndUpdate(
        { email: normalized },
        {
          $setOnInsert: {
            email: normalized,
            role,
            grantedByEmail: 'system',
            active: true,
          },
        },
        { upsert: true, new: true }
      );
    }
    log.info('Access control seed applied', { count: DEFAULT_ACCESS_SEED.length });
  }

  async getUserByEmail(email: string) {
    return MrSoulAccessUser.findOne({
      email: normalizeEmail(email),
      active: true,
    });
  }

  async checkAccess(email: string | undefined | null): Promise<AccessCheckResult> {
    if (!this.isEnabled()) {
      return { allowed: true, role: 'super_admin', email: email ?? undefined };
    }

    if (!email?.trim()) {
      return {
        allowed: false,
        reason:
          'Your Slack profile has no email. Add your @thesouledstore.com email in Slack profile settings, or ask an admin to grant access.',
      };
    }

    const normalized = normalizeEmail(email);
    const doc = await this.getUserByEmail(normalized);
    if (!doc) {
      return {
        allowed: false,
        email: normalized,
        reason:
          `Access denied for \`${normalized}\`. Ask a *MrSoul admin* to run:\n\`@MrSoul grant access ${normalized} member\``,
      };
    }

    return { allowed: true, role: doc.role as AccessRole, email: normalized };
  }

  canGrant(role: AccessRole | undefined): boolean {
    return role === 'super_admin' || role === 'admin';
  }

  canRevoke(role: AccessRole | undefined): boolean {
    return role === 'super_admin';
  }

  canGrantRole(actorRole: AccessRole, targetRole: AccessRole): boolean {
    if (actorRole === 'super_admin') return true;
    if (actorRole === 'admin') {
      return targetRole === 'member' || targetRole === 'admin';
    }
    return false;
  }

  async handleAdminCommand(
    command: AccessAdminCommand,
    actor: { email: string; slackUserId: string; name: string }
  ): Promise<{ handled: true; message: string; ephemeral: boolean } | { handled: false }> {
    if (!this.isEnabled()) {
      return { handled: true, ephemeral: true, message: 'Access control is disabled.' };
    }

    const actorAccess = await this.checkAccess(actor.email);
    if (!actorAccess.allowed || !actorAccess.role) {
      return {
        handled: true,
        ephemeral: true,
        message: actorAccess.reason ?? 'You do not have access to MrSoul.',
      };
    }

    if (command.kind === 'my_access') {
      return {
        handled: true,
        ephemeral: true,
        message:
          `*Your MrSoul access*\n` +
          `• Email: \`${actorAccess.email}\`\n` +
          `• Role: *${formatRole(actorAccess.role)}*\n` +
          `• ${formatRoleCapabilities(actorAccess.role)}\n` +
          (actorAccess.role === 'super_admin'
            ? '• You can grant/revoke access (`grant access` / `revoke access`).'
            : actorAccess.role === 'admin'
              ? '• You can grant access (`grant access email member|admin`).'
              : ''),
      };
    }

    if (command.kind === 'list') {
      if (!this.canGrant(actorAccess.role)) {
        return {
          handled: true,
          ephemeral: true,
          message: 'Only *admin* and *super admin* can list access.',
        };
      }
      const users = await MrSoulAccessUser.find({ active: true })
        .sort({ role: -1, email: 1 })
        .limit(100);
      if (users.length === 0) {
        return { handled: true, ephemeral: true, message: 'No active MrSoul users.' };
      }
      const lines = users.map(u => {
        const by = u.grantedByEmail ? ` _(by ${u.grantedByEmail})_` : '';
        return `• \`${u.email}\` — *${formatRole(u.role as AccessRole)}*${by}`;
      });
      return {
        handled: true,
        ephemeral: true,
        message: `*MrSoul access list (${users.length})*\n${lines.join('\n')}`,
      };
    }

    if (command.kind === 'grant') {
      if (!this.canGrant(actorAccess.role)) {
        return {
          handled: true,
          ephemeral: true,
          message: 'Only *admin* and *super admin* can grant access.',
        };
      }
      if (!this.canGrantRole(actorAccess.role, command.role)) {
        return {
          handled: true,
          ephemeral: true,
          message:
            actorAccess.role === 'admin'
              ? 'Admins can only grant `member` or `admin`. Super admin can grant any role.'
              : 'You cannot grant that role.',
        };
      }

      const targetEmail = normalizeEmail(command.email);
      await MrSoulAccessUser.findOneAndUpdate(
        { email: targetEmail },
        {
          email: targetEmail,
          role: command.role,
          grantedByEmail: actorAccess.email,
          grantedBySlackId: actor.slackUserId,
          active: true,
          revokedAt: undefined,
          revokedByEmail: undefined,
        },
        { upsert: true, new: true }
      );

      log.info('Access granted', {
        target: targetEmail,
        role: command.role,
        by: actorAccess.email,
      });

      return {
        handled: true,
        ephemeral: false,
        message:
          `:white_check_mark: *Access granted*\n` +
          `• \`${targetEmail}\` → *${formatRole(command.role)}*\n` +
          `• By: ${actor.name} (\`${actorAccess.email}\`)\n\n` +
          `_They can use @MrSoul and /create-ticket once their Slack email matches._`,
      };
    }

    if (command.kind === 'revoke') {
      if (!this.canRevoke(actorAccess.role)) {
        return {
          handled: true,
          ephemeral: true,
          message:
            'Only *super admin* can remove someone from MrSoul (`revoke access`).\n' +
            'Admins can still *grant* access.',
        };
      }

      const targetEmail = normalizeEmail(command.email);
      const target = await MrSoulAccessUser.findOne({ email: targetEmail, active: true });
      if (!target) {
        return {
          handled: true,
          ephemeral: true,
          message: `No active access found for \`${targetEmail}\`.`,
        };
      }

      if (target.role === 'super_admin') {
        const superCount = await MrSoulAccessUser.countDocuments({
          role: 'super_admin',
          active: true,
        });
        if (superCount <= 1) {
          return {
            handled: true,
            ephemeral: true,
            message: 'Cannot remove the last *super admin*.',
          };
        }
      }

      target.active = false;
      target.revokedAt = new Date();
      target.revokedByEmail = actorAccess.email;
      await target.save();

      log.info('Access revoked', { target: targetEmail, by: actorAccess.email });

      return {
        handled: true,
        ephemeral: false,
        message:
          `:no_entry: *Removed from MrSoul*\n` +
          `• \`${targetEmail}\` no longer has access.\n` +
          `• By super admin: ${actor.name} (\`${actorAccess.email}\`)`,
      };
    }

    return { handled: false };
  }

  hasMinRole(userRole: AccessRole | undefined, required: AccessRole): boolean {
    if (!userRole) return false;
    return ROLE_RANK[userRole] >= ROLE_RANK[required];
  }

  canPerformWrites(role: AccessRole | undefined): boolean {
    return canPerformWrites(role, this.isEnabled());
  }

  async listActiveUsers(): Promise<
    Array<{ email: string; role: AccessRole; slackUserId?: string; grantedByEmail?: string }>
  > {
    const users = await MrSoulAccessUser.find({ active: true }).sort({ role: -1, email: 1 }).limit(200);
    return users.map(u => ({
      email: u.email,
      role: u.role as AccessRole,
      slackUserId: u.slackUserId,
      grantedByEmail: u.grantedByEmail,
    }));
  }

  async setUserRole(
    email: string,
    role: AccessRole,
    grantedBy: string
  ): Promise<{ email: string; role: AccessRole }> {
    const targetEmail = normalizeEmail(email);
    await MrSoulAccessUser.findOneAndUpdate(
      { email: targetEmail },
      {
        email: targetEmail,
        role,
        grantedByEmail: grantedBy,
        active: true,
        revokedAt: undefined,
        revokedByEmail: undefined,
      },
      { upsert: true, new: true }
    );
    return { email: targetEmail, role };
  }

  async revokeUser(email: string, revokedBy: string): Promise<boolean> {
    const targetEmail = normalizeEmail(email);
    const target = await MrSoulAccessUser.findOne({ email: targetEmail, active: true });
    if (!target) return false;

    if (target.role === 'super_admin') {
      const superCount = await MrSoulAccessUser.countDocuments({
        role: 'super_admin',
        active: true,
      });
      if (superCount <= 1) {
        throw new Error('Cannot remove the last super admin');
      }
    }

    target.active = false;
    target.revokedAt = new Date();
    target.revokedByEmail = revokedBy;
    await target.save();
    return true;
  }
}

function formatRole(role: AccessRole): string {
  switch (role) {
    case 'super_admin':
      return 'Super Admin';
    case 'admin':
      return 'Admin';
    default:
      return 'Member';
  }
}

export const accessControlService = AccessControlService.getInstance();
