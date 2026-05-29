# CE-Tech Automation — API Reference

Base URL: `http://localhost:3000` (development) | `https://your-domain.com` (production)

All `/api/*` routes require authentication when `API_KEY` env var is set:
```
Authorization: Bearer <API_KEY>
# or
X-Api-Key: <API_KEY>
```

Every response includes `X-Request-Id` for tracing.

---

## Table of Contents

- [Health](#health)
- [Issues](#issues)
- [Routing](#routing)
- [Workload](#workload)
- [Webhooks](#webhooks)
- [Error Codes](#error-codes)

---

## Health

### GET /health

Basic liveness check. No auth required.

**Response `200`**
```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "service": "ce-tech-automation",
  "version": "1.0.0",
  "uptime": 3600
}
```

---

### GET /health/detailed

Full health check including service connectivity and memory usage. No auth required.

**Response `200`**
```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "uptime": 3600,
  "services": {
    "mongodb": "connected"
  },
  "memory": {
    "heapUsedMB": 45,
    "heapTotalMB": 68,
    "rssMB": 102
  },
  "node": "v20.11.0"
}
```

---

## Issues

### GET /api/issues

List issues with optional filtering and pagination.

**Query Parameters**

| Parameter | Type | Values | Default | Description |
|-----------|------|--------|---------|-------------|
| `status` | string | `open`, `in_progress`, `pr_opened`, `pr_merged`, `closed`, `resolved` | — | Filter by status |
| `assignee` | string | Slack User ID | — | Filter by assigned developer |
| `priority` | string | `critical`, `urgent`, `high`, `medium`, `low` | — | Filter by priority |
| `limit` | number | 1–200 | `50` | Number of results |
| `offset` | number | ≥0 | `0` | Pagination offset |

**Response `200`**
```json
{
  "success": true,
  "data": {
    "issues": [
      {
        "id": "550e8400-e29b-41d4-a716-446655440000",
        "slackMessageTs": "1705312200.123456",
        "slackChannelId": "C0123456789",
        "slackChannelName": "ce-tech-issues",
        "slackUserId": "U0987654321",
        "slackUserName": "Priya Sharma",
        "originalMessage": "Refund failing after payment success #refund #urgent",
        "hashtags": ["#refund", "#urgent"],
        "priority": "urgent",
        "status": "open",
        "assignment": {
          "primaryOwnerId": "U1111111111",
          "primaryOwnerName": "Rahul",
          "secondaryOwnerIds": [],
          "githubUsername": "rahul",
          "resolvedFromTags": ["#refund"]
        },
        "githubIssue": {
          "issueNumber": 42,
          "issueUrl": "https://github.com/org/repo/issues/42",
          "issueTitle": "[URGENT] Refund failing after payment success",
          "nodeId": "I_kwDO..."
        },
        "slackThread": {
          "channelId": "C0123456789",
          "threadTs": "1705312201.654321"
        },
        "createdAt": "2024-01-15T10:30:00.000Z",
        "updatedAt": "2024-01-15T10:30:05.000Z"
      }
    ],
    "total": 1,
    "limit": 50,
    "offset": 0
  }
}
```

**Error `400`** — Invalid query params
```json
{
  "success": false,
  "error": "VALIDATION_ERROR",
  "details": [{ "path": ["status"], "message": "Invalid enum value" }]
}
```

---

### GET /api/issues/:id

Get a single issue by its UUID.

**Path Parameters**
| Parameter | Description |
|-----------|-------------|
| `id` | Issue UUID |

**Response `200`** — Returns the issue object (same shape as above)

**Response `404`**
```json
{
  "success": false,
  "error": "NOT_FOUND",
  "message": "Issue not found"
}
```

---

### PATCH /api/issues/:id/status

Manually update an issue's status. This will also post an update to the linked Slack thread.

**Request Body**
```json
{
  "status": "in_progress"
}
```

Valid values: `open`, `in_progress`, `pr_opened`, `pr_merged`, `closed`, `resolved`

**Response `200`**
```json
{
  "success": true,
  "message": "Status updated to in_progress"
}
```

---

### GET /api/issues/:id/audit

Get the full audit trail for an issue.

**Response `200`**
```json
{
  "success": true,
  "data": [
    {
      "timestamp": "2024-01-15T10:30:00.000Z",
      "action": "issue_created",
      "actor": "system",
      "details": {
        "hashtags": ["#refund", "#urgent"],
        "priority": "urgent",
        "assignedTo": "Rahul"
      },
      "success": true
    },
    {
      "timestamp": "2024-01-15T10:30:01.500Z",
      "action": "github_issue_created",
      "actor": "system",
      "details": {
        "issueNumber": 42,
        "issueUrl": "https://github.com/org/repo/issues/42"
      },
      "success": true
    }
  ]
}
```

---

## Routing

### GET /api/routing

List all active hashtag→developer routing mappings.

**Response `200`**
```json
{
  "success": true,
  "data": [
    {
      "tag": "#refund",
      "primaryOwner": "U1111111111",
      "primaryOwnerName": "Rahul",
      "secondaryOwners": [],
      "githubUsername": "rahul",
      "active": true
    },
    {
      "tag": "#payment",
      "primaryOwner": "U2222222222",
      "primaryOwnerName": "Aman",
      "secondaryOwners": ["U3333333333"],
      "githubUsername": "aman",
      "active": true
    }
  ]
}
```

---

### PUT /api/routing

Create or update a routing mapping (upsert by `tag`).

**Request Body**
```json
{
  "tag": "#shipping",
  "primaryOwner": "U4444444444",
  "primaryOwnerName": "Vikram",
  "secondaryOwners": ["U5555555555"],
  "githubUsername": "vikram-dev",
  "active": true
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `tag` | ✅ | Hashtag (e.g. `#refund`) |
| `primaryOwner` | ✅ | Slack User ID of primary assignee |
| `primaryOwnerName` | ✅ | Display name |
| `secondaryOwners` | — | Array of Slack User IDs to CC |
| `githubUsername` | ✅ | GitHub username for issue assignment |
| `active` | — | Default `true`. Set `false` to disable. |

**Response `200`**
```json
{
  "success": true,
  "message": "Mapping for #shipping updated"
}
```

---

### DELETE /api/routing/:tag

Deactivate a routing mapping (soft delete — sets `active: false`).

**Path Parameters**
| Parameter | Description |
|-----------|-------------|
| `tag` | URL-encoded tag, e.g. `%23refund` for `#refund` |

```bash
curl -X DELETE http://localhost:3000/api/routing/%23refund
```

**Response `200`**
```json
{
  "success": true,
  "message": "Mapping for #refund deactivated"
}
```

---

## Workload

### GET /api/workload/summary

Per-developer workload aggregation.

**Response `200`**
```json
{
  "success": true,
  "data": [
    {
      "developerId": "U1111111111",
      "developerName": "Rahul",
      "openIssues": 3,
      "inProgressIssues": 1,
      "resolvedThisWeek": 5,
      "totalAssigned": 24
    },
    {
      "developerId": "U2222222222",
      "developerName": "Aman",
      "openIssues": 1,
      "inProgressIssues": 2,
      "resolvedThisWeek": 3,
      "totalAssigned": 18
    }
  ]
}
```

---

## Webhooks

### POST /webhooks/github

Receives GitHub webhook events. No API key required — authenticated via `X-Hub-Signature-256`.

**Request Headers**
| Header | Description |
|--------|-------------|
| `X-GitHub-Event` | Event type (`pull_request`, `issues`) |
| `X-GitHub-Delivery` | Unique delivery ID |
| `X-Hub-Signature-256` | HMAC-SHA256 signature (if `GITHUB_WEBHOOK_SECRET` is set) |

**Supported Events**

| Event | Action | Platform Response |
|-------|--------|-------------------|
| `pull_request` | `opened` | Status → `pr_opened`, Slack thread updated |
| `pull_request` | `closed` (merged) | Status → `pr_merged`, Slack thread updated |
| `issues` | `closed` | Status → `closed`, Slack thread updated |

**Response `202`** (always acknowledged immediately; processing is async)
```json
{
  "received": true,
  "delivery": "abc123-delivery-id"
}
```

**Response `401`** — Invalid signature
```json
{
  "error": "INVALID_SIGNATURE"
}
```

---

## Error Codes

| HTTP | Code | Description |
|------|------|-------------|
| 400 | `VALIDATION_ERROR` | Request body/query params failed validation. Check `details` array. |
| 401 | `UNAUTHORIZED` | Missing or invalid API key |
| 404 | `NOT_FOUND` | Resource not found |
| 409 | `DUPLICATE_ENTRY` | Resource already exists |
| 429 | `TOO_MANY_REQUESTS` | Rate limit exceeded |
| 500 | `INTERNAL_ERROR` | Unexpected server error |

---

## Rate Limits

| Route group | Limit |
|------------|-------|
| `/api/routing` (writes) | 30 req/min |
| All `/api/*` | 100 req/min (configurable via `RATE_LIMIT_MAX_REQUESTS`) |
| `/webhooks/*` | No limit (GitHub controls frequency) |

---

## Example: Full cURL flow

```bash
BASE=http://localhost:3000
KEY=your-api-key

# 1. Check health
curl $BASE/health

# 2. List open urgent issues assigned to Rahul
curl -H "X-Api-Key: $KEY" \
  "$BASE/api/issues?status=open&priority=urgent&assignee=U1111111111"

# 3. Update routing — add #checkout assigned to Meera
curl -X PUT -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"tag":"#checkout","primaryOwner":"U6666666","primaryOwnerName":"Meera","secondaryOwners":[],"githubUsername":"meera-dev","active":true}' \
  $BASE/api/routing

# 4. Manually mark an issue as resolved
curl -X PATCH -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"status":"resolved"}' \
  $BASE/api/issues/550e8400-e29b-41d4-a716-446655440000/status

# 5. Check developer workload
curl -H "X-Api-Key: $KEY" $BASE/api/workload/summary
```
