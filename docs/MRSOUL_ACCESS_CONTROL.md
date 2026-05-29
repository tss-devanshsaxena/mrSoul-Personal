# MrSoul access control (email allowlist)

Only people on the **allowlist** can use MrSoul. Access is tied to the **email on their Slack profile** (must match the allowlist).

## Default roles (seeded on startup)

| Email | Role | Can use MrSoul | Grant access | Remove users |
|-------|------|----------------|--------------|--------------|
| devansh.saxena@thesouledstore.com | **Super Admin** | Yes | Yes (any role) | Yes (`revoke access`) |
| rahul.jaisheel@thesouledstore.com | **Admin** | Yes | Yes (`member` / `admin` only) | No |
| jaynam.mehta@thesouledstore.com | **Member** | Yes (read/ask only) | No | No |
| saif.khan@thesouledstore.com | **Member** | Yes (read/ask only) | No | No |

## What each role can do in Slack

| Capability | Member | Admin | Super Admin |
|------------|--------|-------|-------------|
| Ask workload / team status (`what is Akriti working on?`) | Yes | Yes | Yes |
| Create GitHub issues (hashtags, `create issue`) | No | Yes | Yes |
| `/create-ticket`, PRDs, approve ticket flow | No | Yes | Yes |
| “Who should own this?” / assign suggestions | No | Yes | Yes |
| Grant access | No | Yes | Yes |
| Revoke access | No | No | Yes |

Members who try to create issues or tickets get a short ephemeral explanation in Slack.

## Admin portal (web)

**Admin → Slack bot access** (`/admin/access.html`): grant roles by email, list users, remove access.

## Slack app requirement

Add bot scope **`users:read.email`** and reinstall the app so the bot can read profile emails.

## Grant access (Admin + Super Admin)

```
@MrSoul grant access someone@thesouledstore.com member
@MrSoul grant access someone@thesouledstore.com admin
```

Super admin only:

```
@MrSoul grant access someone@thesouledstore.com super_admin
```

## Remove from MrSoul (Super Admin only)

“Delete” access = revoke allowlist entry:

```
@MrSoul revoke access someone@thesouledstore.com
```

Also works: `remove access` / `delete access`

## List & status

```
@MrSoul list access
@MrSoul my access
```

## Configuration

```bash
ACCESS_CONTROL_ENABLED=true   # default true
```

Set to `false` only for local debugging (opens MrSoul to everyone).

## How it works

1. User messages MrSoul or runs `/create-ticket`
2. Bot reads `users.info` → profile email
3. MongoDB collection `MrSoulAccessUser` is checked
4. If not allowed → ephemeral “Access denied” with grant hint
5. Admins/super admin can manage users via commands above

Seed runs on every `npm run dev` / start (upserts default four emails without overwriting existing roles).

## Files

- `src/services/accessControl.ts` — roles, grant, revoke, seed
- `src/services/slackAccess.ts` — Slack gate + admin commands
- `src/utils/accessCommands.ts` — command parsing
- `src/models/index.ts` — `MrSoulAccessUser` schema
