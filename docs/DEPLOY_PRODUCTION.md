# Deploy MrSoul for your team (production)

This is the **step-by-step rollout guide** so everyone at TSS can use MrSoul in Slack — not only on your laptop.

---

## What you are deploying

One always-on **Node.js service** that:

- Connects to **Slack** (Socket Mode — no public URL needed for Slack)
- Connects to **MongoDB Atlas** (issues, routing, access control, ticket sessions)
- Calls **GitHub** (issues, project board, PRD file upload)
- Calls **Groq** (chat, `/create-ticket`, PRDs)

**Important:** Run **exactly one instance** of the app per Slack app (one `SLACK_APP_TOKEN`). Do not scale to 2+ replicas with Socket Mode.

---

## Architecture (production)

```
Slack workspace  ──Socket Mode──►  MrSoul app (Railway / VM / Docker)
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                 ▼
              MongoDB Atlas      GitHub API          Groq API
                    │
              (optional) HTTPS :443
                    ▼
              GitHub webhooks → /webhooks/github
```

You need a **public HTTPS URL** only for:

- GitHub webhooks (`POST /webhooks/github`)
- Optional health checks from your host

Slack events use **Socket Mode** (`SLACK_APP_TOKEN`) — they do not hit your server URL.

---

## Pre-flight checklist

### 1. Slack app ([api.slack.com/apps](https://api.slack.com/apps))

- [ ] **Socket Mode** enabled → create **App-Level Token** with `connections:write` → `SLACK_APP_TOKEN`
- [ ] **Bot Token Scopes** (install to workspace after adding):
  - `chat:write`, `channels:history`, `groups:history`
  - `commands`, `files:write`, `views:write`, `pins:write`
  - `users:read.email` (**required** for access control)
- [ ] **Slash commands:** `/mrsoul`, `/create-ticket`
- [ ] Copy **Bot User OAuth Token** → `SLACK_BOT_TOKEN`
- [ ] Copy **Signing Secret** → `SLACK_SIGNING_SECRET`
- [ ] Copy **Bot user ID** → `SLACK_BOT_USER_ID`
- [ ] Invite **@MrSoul** to `#mrsoul` (or your intake channel)
- [ ] Set `SLACK_MONITORED_CHANNELS` to that channel’s **ID** (right-click channel → copy link → ID in URL)

### 2. MongoDB Atlas

- [ ] Create cluster (free tier OK for pilot)
- [ ] Database user with read/write on `ce-tech-automation`
- [ ] Network access: allow your server IP or `0.0.0.0/0` (Atlas “everywhere”) for cloud hosts
- [ ] Connection string → `MONGODB_URI`

### 3. GitHub

- [ ] PAT or GitHub App with **repo** scope (read/write issues, contents for PRD upload)
- [ ] Token can assign issues on `thesouledstore-tss/roadmap`
- [ ] Webhook on repo (or org):
  - URL: `https://YOUR_DOMAIN/webhooks/github`
  - Secret: same as `GITHUB_WEBHOOK_SECRET`
  - Events: **Issues**, **Pull requests**

### 4. Groq

- [ ] API key from [console.groq.com](https://console.groq.com) → `GROQ_API_KEY`

### 5. Secrets

- [ ] Copy `.env.example` → production secrets (host env / vault)
- [ ] **Never commit** `.env` to git
- [ ] Rotate any keys that were ever pasted in chat

---

## Choose a host (pick one)

| Option | Best for | Difficulty |
|--------|----------|------------|
| **A. Railway / Render / Fly.io** | Fast team rollout, always-on | Easy |
| **B. Docker on a VM** | Full control, TSS infra | Medium |
| **C. PM2 on a VM** | Simple Node on existing server | Medium |

---

## Option A — Railway (recommended)

### 1. Push code to GitHub

```bash
git init   # if needed
git remote add origin https://github.com/YOUR_ORG/ce-tech-automation.git
git push -u origin main
```

### 2. Create Railway project

1. [railway.app](https://railway.app) → New Project → Deploy from GitHub repo  
2. **Build command:** `npm ci && npm run build`  
3. **Start command:** `npm run start:prod`  
4. **Replicas:** `1` only  

### 3. Set environment variables

Paste all variables from `.env.example` in Railway **Variables** (use production values).

Minimum:

```
NODE_ENV=production
PORT=3000
SLACK_BOT_TOKEN=...
SLACK_SIGNING_SECRET=...
SLACK_APP_TOKEN=...
SLACK_BOT_USER_ID=...
SLACK_MONITORED_CHANNELS=C0...
MONGODB_URI=mongodb+srv://...
GITHUB_TOKEN=...
GITHUB_OWNER=thesouledstore-tss
GITHUB_REPO=roadmap
GITHUB_WEBHOOK_SECRET=...
GITHUB_PROJECT_ORG=thesouledstore-tss
GITHUB_PROJECT_NUMBER=1
GROQ_ENABLED=true
GROQ_API_KEY=...
GROQ_ADVISOR_ENABLED=true
ACCESS_CONTROL_ENABLED=true
TICKET_FLOW_ENABLED=true
TRACKER_TYPE=mongodb_only
```

### 4. Public domain (for GitHub webhooks)

Railway → Settings → Networking → **Generate domain** → e.g. `mrsoul-production.up.railway.app`

Use in GitHub webhook:

```
https://mrsoul-production.up.railway.app/webhooks/github
```

Health check:

```
https://mrsoul-production.up.railway.app/health
```

### 5. Verify

- Deploy logs show: `Slack app started in Socket Mode` and `fully operational`  
- In Slack: `@MrSoul my access` (if your email is seeded)  
- `/create-ticket` test in monitored channel  

---

## Option B — Docker on a server

On a Linux VM with Docker installed:

```bash
git clone <your-repo-url>
cd ce-tech-automation
cp .env.example .env
nano .env   # fill production values — MONGODB_URI = Atlas

npm run docker:prod
npm run docker:logs
```

Health:

```bash
curl http://localhost:3000/health
```

Put **nginx + SSL** in front for GitHub webhooks (see `DEPLOYMENT.md` nginx section).

---

## Option C — PM2 on a VM

```bash
git clone <your-repo-url>
cd ce-tech-automation
cp .env.example .env
nano .env

npm ci
npm run build

npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

Open firewall port **3000** only if needed internally; expose **443** via nginx for webhooks.

---

## After deploy — team onboarding

### 1. Post guidelines once

```bash
# On server or locally with prod .env:
npm run slack:guidelines
```

Or set `SLACK_POST_GUIDELINES_ON_START=true` once, restart, then set back to `false`.

### 2. Access control (already seeded)

| Email | Role |
|-------|------|
| devansh.saxena@thesouledstore.com | Super Admin |
| rahul.jaisheel@thesouledstore.com | Admin |
| jaynam.mehta@thesouledstore.com | Member |
| saif.khan@thesouledstore.com | Member |

Admins grant others:

```
@MrSoul grant access name@thesouledstore.com member
```

Users must have matching email on **Slack profile**.

### 3. Tell the team

Share in `#mrsoul`:

- `@MrSoul help` or `/mrsoul` — guide  
- `/create-ticket` — PRD + GitHub flow  
- `@MrSoul who is working on what?` — Groq + live board  

Full doc: [MRSOUL_PLATFORM.md](./MRSOUL_PLATFORM.md)

---

## Monitoring

| Check | Command / URL |
|-------|----------------|
| Liveness | `GET /health` |
| Detailed | `GET /health/detailed` |
| Logs (Docker) | `npm run docker:logs` |
| Logs (PM2) | `pm2 logs mrsoul` |

Alert if:

- `/health` not 200 for 2+ minutes  
- Logs show `Groq daily budget exceeded` (raise `GROQ_MAX_CALLS_PER_DAY`)  
- `Access denied` for many users → Slack missing `users:read.email` scope  

---

## Updates (new version)

```bash
git pull
npm run build          # or docker:prod rebuild
pm2 restart mrsoul     # or docker compose restart
```

Zero-downtime: not required for Socket Mode if restart takes &lt;30s.

---

## Security reminders

- One bot instance per Slack app token  
- `ACCESS_CONTROL_ENABLED=true` in production  
- GitHub token minimum scopes needed (`repo`)  
- Rotate Groq/GitHub/Slack tokens if exposed  
- MongoDB Atlas IP allowlist in production if possible  

---

## Related docs

| Doc | Contents |
|-----|----------|
| [DEPLOYMENT.md](../DEPLOYMENT.md) | Docker dev, nginx, k8s, backups |
| [SLACK_MRSOUL_SETUP.md](./SLACK_MRSOUL_SETUP.md) | Slack scopes & commands |
| [MRSOUL_ACCESS_CONTROL.md](./MRSOUL_ACCESS_CONTROL.md) | Roles & grant/revoke |
| [MRSOUL_PLATFORM.md](./MRSOUL_PLATFORM.md) | Full product & technical guide |
