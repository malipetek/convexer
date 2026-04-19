# ── Better Auth sidecar stages ──────────────────────────────────────────────
FROM node:22-alpine AS betterauth-builder
WORKDIR /app
COPY better-auth-sidecar/package.json ./
RUN npm install
COPY better-auth-sidecar/tsconfig.json ./
COPY better-auth-sidecar/src ./src
RUN npm run build

FROM node:22-alpine AS betterauth-runtime
WORKDIR /app
COPY --from=betterauth-builder /app/node_modules ./node_modules
COPY --from=betterauth-builder /app/dist ./dist
EXPOSE 4200
CMD ["node", "dist/index.js"]

# ── Convexer stages ──────────────────────────────────────────────────────────
# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json ./server/
COPY client/package.json ./client/

# Copy client source files
COPY client/index.html ./client/
COPY client/src ./client/src
COPY client/vite.config.ts ./client/
COPY client/tsconfig.json ./client/
COPY client/postcss.config.js ./client/
COPY client/tailwind.config.js ./client/

# Install dependencies with npm for traditional node_modules structure
RUN npm install

# Build client with npm
RUN npm run build --workspace=client

# Runtime stage
FROM node:22-alpine

WORKDIR /app

# Install backup and SSH utilities
RUN apk add --no-cache rsync openssh-client postgresql-client tar gzip rclone

# Install tsx globally
RUN npm install -g tsx

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json ./server/

# Copy node_modules from build stage
COPY --from=builder /app/node_modules ./node_modules

# Copy server source
COPY server/src ./server/src
COPY server/tsconfig.json ./server/

# Copy built client
COPY --from=builder /app/client/dist ./client/dist

# Expose port
EXPOSE 4000

# Set data directory and node path for module resolution
ENV DATA_DIR=/app/server/data
ENV NODE_PATH=/app/node_modules

# Start server from workspace root where node_modules are located
CMD ["tsx", "server/src/index.ts"]
