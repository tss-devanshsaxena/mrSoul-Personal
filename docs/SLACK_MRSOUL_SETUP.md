# MrSoul Slack UX setup

Channel guide, slash-command suggestions, and pinned guidelines for `#ce-tech-issues-monitored`.

**Developer:** Devansh Saxena — Associate Product Manager, Tech

## 1. Slack app scopes (OAuth)

Add these **Bot Token Scopes** and reinstall the app:

| Scope | Why |
|-------|-----|
| `chat:write` | Post replies |
| `channels:history` | Read thread context |
| `groups:history` | Private channels (if used) |
| `pins:write` | Pin guidelines at top |
| `channels:manage` | Set channel topic (public channels) |
| `commands` | `/mrsoul` and `/create-ticket` slash commands |
| `users:read.email` | **Required** for access control + **store outreach** (lookup user by email) |
| `im:write` | **Required** for store outreach (open DM + send daily messages) |
| `files:write` | Upload PRD `.docx` to Slack thread |
| `views:write` | `/create-ticket` modal form |
| `groups:read` + `groups:history` | Private channels like `#mrsoul` (cleanup script) |
| `im:read` + `im:history` | Optional: delete bot messages in DMs (`npm run slack:clear -- --all`) |

## 2. Slash command (typing suggestions)

In [api.slack.com/apps](https://api.slack.com/apps) → your app → **Slash Commands** → **Create New Command**:

| Field | Value |
|-------|--------|
| Command | `/mrsoul` |
| Request URL | _(Socket Mode: leave blank or use Bolt URL if HTTP mode)_ |
| Short Description | `CE-Tech advisor: workload, assignments & issues` |
| Usage Hint | `[help]` |

With **Socket Mode**, Bolt receives slash commands automatically after you add the command name in the manifest (no public URL required).

Users see `/mrsoul` when they type `/` in the message box.

### `/create-ticket` (Groq-powered ticket + PRD flow)

| Field | Value |
|-------|--------|
| Command | `/create-ticket` |
| Short Description | `Start a ticket: problem review → PRD → GitHub issue` |
| Usage Hint | `[describe the problem, or leave blank for a form]` |

**Flow:**

1. `/create-ticket` (or paste details after the command) — Groq formats a problem summary in a channel thread.
2. **Approve** / **Reject** (buttons or reply `approve` / `reject`). Comment in thread to revise the summary.
3. On approve — Groq drafts a PRD and uploads a **`.docx`** in the thread.
4. When ready: `Good to go raise this ticket to: <developer name or tss-login>` — creates a GitHub issue with:
   - Full PRD markdown in the issue description
   - A GitHub comment with **download link** to `docs/prds/issue-<N>/PRD-….docx` in the repo
   - The same `.docx` re-posted in the Slack thread

**GitHub token:** your `GITHUB_TOKEN` needs **`repo`** scope (read/write contents) to upload the `.docx`. If upload fails, the PRD is still added as a markdown comment on the issue.

**Env:**

```bash
GROQ_ENABLED=true
GROQ_API_KEY=your_groq_key
GROQ_MODEL=llama-3.3-70b-versatile
TICKET_FLOW_ENABLED=true
```

## 3. Pin guidelines at top of channel

On server start, only if `SLACK_POST_GUIDELINES_ON_START=true` (default is **false**), the bot will **post and pin** the guidelines. Topic/description are only set when `SLACK_SET_CHANNEL_META=true` (also default **false**) — each API change spams non-deletable gray log lines.

Manual one-time setup (recommended):

Run manually anytime:

```bash
npm run slack:guidelines
```

Requires the bot to be **invited** to the channel and have `pins:write` + `channels:manage`.

## 4. @MrSoul behavior

| User action | Bot response |
|-------------|----------------|
| `@MrSoul` or `@MrSoul help` | Ephemeral guidelines + buttons (only you see it) |
| `/mrsoul` | Same guide (ephemeral) |
| Tap a **Quick action** button | Ephemeral “copy and send” text with full `@MrSoul …` prompt |
| `@MrSoul what is tss-… working on?` | Groq answer with **live GitHub** board data |
| `@MrSoul who should own …?` / general questions | Groq + routing/triage context |
| `create issue …` in thread | Creates GitHub issue in same thread |
| Continue chatting in thread `@MrSoul …` | Groq remembers thread context |

### Groq for everyday @MrSoul chat

When `GROQ_ADVISOR_ENABLED=true` (default), every `@MrSoul` question (except issue hashtags) is answered by **Groq** using live data:

- TSS project board items & workload
- Developer routing map
- Triage scores for “who should own this?”
- Thread history (when replying in a thread)

```bash
GROQ_ADVISOR_ENABLED=true
GROQ_MAX_CALLS_PER_DAY=150
```

Falls back to deterministic blocks or ADK (`ADK_ADVISOR_MODE=agent`) if Groq is unavailable.

> Slack does not allow third-party apps to inject custom text into the `@mention` autocomplete dropdown. Use **channel topic**, **pinned message**, and **`/mrsoul`** for discoverability.

## 5. Env

```bash
SLACK_POST_GUIDELINES_ON_START=false
SLACK_SET_CHANNEL_META=false
SLACK_MONITORED_CHANNELS=C0B4ZGCSZSN
SLACK_GUIDELINES_CHANNELS=C0B4ZGCSZSN   # optional; defaults to monitored list
SLACK_BOT_USER_ID=U0B4ZJC9VM0
```

## 6. Clear channel / DM clutter

```bash
npm run slack:clear -- --yes              # monitored channel(s) by ID
npm run slack:clear -- --channel mrsoul --yes   # needs groups:read for private #mrsoul
npm run slack:clear -- --all --yes        # all convos + DMs (needs im:read, im:history)
```

**Cannot delete via API:** gray “set the channel description/topic” system lines. **Fix:** archive `#mrsoul`, create a new channel, update `SLACK_MONITORED_CHANNELS` with the new channel ID, then `npm run slack:guidelines` once.

**Human DM history** (Rahul, Akriti, etc.): Slack UI only — open each DM → ⋮ → **Delete conversation**.

## 7. Store outreach (admin portal DMs)

If **Send messages** fails with `missing_scope`, add these bot scopes and **Reinstall to Workspace**:

| Scope | Why |
|-------|-----|
| `users:read.email` | Find Slack user from store owner email |
| `im:write` | Open DM channel (`conversations.open`) |
| `chat:write` | Post the message |
| `pins:write` | Pin message in DM (optional; turn off in schedule if you skip this scope) |

After reinstall, copy the new **Bot User OAuth Token** into `SLACK_BOT_TOKEN` on Railway / `.env` and restart the app.
