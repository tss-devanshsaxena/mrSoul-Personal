# CE-Tech Automation — Deployment Guide

> **Team rollout (MrSoul + Groq + access control):** start with **[docs/DEPLOY_PRODUCTION.md](./docs/DEPLOY_PRODUCTION.md)** — Railway, Docker prod, PM2, and Slack checklist.

This guide covers infrastructure details:
1. **Docker Compose** (local / all-in-one with Mongo + Redis)
2. **Docker production** (`docker-compose.prod.yml` + Atlas)
3. **Kubernetes** (for scale — use 1 replica with Socket Mode)
4. **VM / PM2** (bare metal)

---

## Prerequisites Checklist

Before deploying, ensure you have:

- [ ] Slack app created and installed (see [Slack Setup](#slack-setup))
- [ ] GitHub token with `Issues: Read/Write` permission
- [ ] GitHub webhook configured (for PR/issue sync)
- [ ] MongoDB (self-hosted or Atlas)
- [ ] Server with Docker installed OR Node.js 20+
- [ ] Domain name (for Slack HTTP mode and GitHub webhooks)
- [ ] SSL certificate (Let's Encrypt recommended)

---

## 1. Docker — production (Atlas, no local Mongo)

Use when deploying to a server with **MongoDB Atlas** (recommended for team use):

```bash
cp .env.example .env
# Set MONGODB_URI to Atlas, SLACK_APP_TOKEN, GROQ_API_KEY, etc.

npm run docker:prod
curl http://localhost:3000/health
```

Only the **app** container runs. Logs: `npm run docker:logs`.

---

## 2. Docker Compose — local / full stack

### Step 1: Clone and configure

```bash
git clone <your-repo>
cd ce-tech-automation

cp .env.example .env
nano .env  # Fill in all required values
```

Minimum required `.env` values:
```env
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_MONITORED_CHANNELS=C0123456789,C9876543210
GITHUB_TOKEN=ghp_...
GITHUB_OWNER=your-org
GITHUB_REPO=your-repo
GITHUB_WEBHOOK_SECRET=a-random-secret-string
```

### Step 2: Build and start

```bash
# Pull base images and build
docker-compose build

# Start all services (MongoDB + Redis + App)
docker-compose up -d

# Verify everything started
docker-compose ps
docker-compose logs -f app
```

### Step 3: Seed routing mappings

```bash
docker-compose exec app node dist/scripts/seed.js
```

### Step 4: Verify

```bash
# Health check
curl http://localhost:3000/health

# Should return: {"status":"ok",...}
```

### Step 5: Set up nginx reverse proxy

```bash
sudo apt install nginx certbot python3-certbot-nginx

# Create nginx config
sudo nano /etc/nginx/sites-available/ce-tech-automation
```

Paste:
```nginx
server {
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Request-Id $request_id;
        proxy_connect_timeout 10s;
        proxy_read_timeout 30s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/ce-tech-automation /etc/nginx/sites-enabled/
sudo certbot --nginx -d your-domain.com
sudo nginx -t && sudo systemctl reload nginx
```

---

## 3. Kubernetes Deployment

> **Socket Mode:** set `replicas: 1` only. Multiple pods share one `SLACK_APP_TOKEN` and will conflict.

### Namespace and secrets

```bash
kubectl create namespace ce-tech

kubectl create secret generic ce-tech-secrets \
  --from-env-file=.env \
  -n ce-tech
```

### Deployment manifest

```yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ce-tech-automation
  namespace: ce-tech
spec:
  replicas: 2
  selector:
    matchLabels:
      app: ce-tech-automation
  template:
    metadata:
      labels:
        app: ce-tech-automation
    spec:
      containers:
        - name: app
          image: your-registry/ce-tech-automation:latest
          ports:
            - containerPort: 3000
          envFrom:
            - secretRef:
                name: ce-tech-secrets
          livenessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 30
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 10
          resources:
            requests:
              memory: "256Mi"
              cpu: "100m"
            limits:
              memory: "512Mi"
              cpu: "500m"
---
apiVersion: v1
kind: Service
metadata:
  name: ce-tech-automation
  namespace: ce-tech
spec:
  selector:
    app: ce-tech-automation
  ports:
    - port: 80
      targetPort: 3000
  type: ClusterIP
```

```bash
kubectl apply -f k8s/deployment.yaml
kubectl rollout status deployment/ce-tech-automation -n ce-tech
```

---

## 4. VM / Bare Metal Deployment

### Install Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### Install PM2

```bash
npm install -g pm2

# Build the app
npm run build

# Start with PM2
pm2 start dist/index.js \
  --name ce-tech-automation \
  --instances 1 \
  --max-memory-restart 400M \
  --log logs/pm2.log

# Save and enable startup
pm2 startup
pm2 save
```

### PM2 (recommended)

A ready-made config is in the repo root:

```bash
npm run build
pm2 start ecosystem.config.js
pm2 save && pm2 startup
```

---

## Post-Deployment Checklist

### Test Slack integration

1. Invite the bot to your monitored channel:
   ```
   /invite @CE-Tech Automation
   ```

2. Post a test message:
   ```
   Test issue please ignore #refund #low
   ```

3. Within 3 seconds you should see a reply thread.

### Test GitHub webhook

```bash
curl -X POST https://your-domain.com/webhooks/github \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: pull_request" \
  -H "X-GitHub-Delivery: test-delivery-1" \
  -d '{
    "action": "opened",
    "pull_request": {
      "number": 1,
      "title": "Test PR",
      "html_url": "https://github.com/org/repo/pull/1",
      "merged": false
    },
    "repository": {"full_name": "org/repo"},
    "sender": {"login": "testuser"}
  }'
# Expected: {"received":true,"delivery":"test-delivery-1"}
```

### Configure GitHub webhook

1. GitHub repo → Settings → Webhooks → Add webhook
2. Payload URL: `https://your-domain.com/webhooks/github`
3. Content type: `application/json`
4. Secret: same as `GITHUB_WEBHOOK_SECRET` in `.env`
5. Events: select **Issues** and **Pull requests**
6. Save and check the delivery history shows ✅

---

## Monitoring

### Log tailing

```bash
# Docker
docker-compose logs -f app

# PM2
pm2 logs ce-tech-automation

# Files (production)
tail -f logs/combined.log
```

### Key metrics to watch

| Metric | Alert threshold |
|--------|----------------|
| Heap memory > 350MB | Restart | 
| MongoDB disconnected | Page on-call |
| GitHub API 429 errors | Investigate rate limits |
| Slack API 429 errors | Already rate-limited in code |
| Startup errors on `/health` | Deployment failed |

---

## Updating the Application

```bash
# Docker Compose
git pull
docker-compose build app
docker-compose up -d --no-deps app

# PM2
git pull
npm run build
pm2 restart ce-tech-automation
```

---

## Backup

MongoDB data is in the `mongo-data` Docker volume. To back up:

```bash
# Dump
docker-compose exec mongo mongodump \
  --db ce-tech-automation \
  --out /tmp/backup

docker cp ce-tech-mongo:/tmp/backup ./backup-$(date +%Y%m%d)

# Restore
docker cp ./backup-20240115 ce-tech-mongo:/tmp/restore
docker-compose exec mongo mongorestore /tmp/restore
```

---

## Environment-Specific Notes

### Development (Socket Mode)
- Set `SLACK_APP_TOKEN` → no public URL needed for Slack
- MongoDB local or Atlas
- `NODE_ENV=development`, `LOG_LEVEL=debug`

### Production (recommended: Socket Mode + Atlas)
- Keep `SLACK_APP_TOKEN` — **one replica only**
- `MONGODB_URI` → MongoDB Atlas
- `NODE_ENV=production`, `LOG_LEVEL=info`
- Public HTTPS URL **only** for GitHub webhooks: `/webhooks/github`
- Enable `GROQ_*`, `ACCESS_CONTROL_ENABLED`, `TICKET_FLOW_ENABLED`
- Slack scope `users:read.email` required

### Production (alternative: HTTP Mode for Slack)
- Remove `SLACK_APP_TOKEN`
- Configure Slack Event Subscriptions → `https://your-domain/slack/events`
- Requires Bolt HTTP adapter changes (not default in this repo)
