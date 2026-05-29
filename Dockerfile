# ============================================================
# CE-Tech Automation Platform — Dockerfile
# Multi-stage build for production efficiency
# ============================================================

# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies
COPY package*.json ./
RUN npm ci --include=dev

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
COPY public/ ./public/
RUN npm run build

# ============================================================
# Stage 2: Production runtime
FROM node:20-alpine AS production

WORKDIR /app

# Security: run as non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S cetech -u 1001

# Install only production dependencies
COPY package*.json ./
RUN npm ci --only=production && \
    npm cache clean --force

# Copy built artifacts + static admin/dashboard UI
COPY --from=builder /app/dist ./dist
COPY public ./public

# Create log directory
RUN mkdir -p /app/logs && chown -R cetech:nodejs /app/logs

# Switch to non-root user
USER cetech

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "const http = require('http'); \
    http.get('http://localhost:${PORT:-3000}/health', (r) => { \
      process.exit(r.statusCode === 200 ? 0 : 1); \
    }).on('error', () => process.exit(1));"

EXPOSE 3000

CMD ["node", "dist/index.js"]
