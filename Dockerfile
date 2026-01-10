# MCP Gateway Dockerfile
# Multi-stage build for minimal production image

# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev)
RUN npm ci

# Copy source files
COPY tsconfig.json ./
COPY scripts/ ./scripts/
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# Prune dev dependencies
RUN npm prune --production

# Production stage
FROM node:22-alpine AS production

WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S mcpgateway && \
    adduser -S mcpgateway -u 1001 -G mcpgateway

# Copy built files and production dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

# Copy config directory (will be overwritten by volume mount)
COPY config/ ./config/

# Set ownership
RUN chown -R mcpgateway:mcpgateway /app

# Switch to non-root user
USER mcpgateway

# Environment variables
ENV NODE_ENV=production
ENV PORT=3010
ENV HOST=0.0.0.0

# Expose port
EXPOSE 3010

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3010/health || exit 1

# Start the gateway
CMD ["node", "dist/index.js"]

