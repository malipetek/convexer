# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json ./server/
COPY client/package.json ./client/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Build client
RUN pnpm build -w client

# Runtime stage
FROM node:22-alpine

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json ./server/

# Install only server dependencies
RUN pnpm install --frozen-lockfile -w server

# Copy server source
COPY server/src ./server/src
COPY server/tsconfig.json ./server/

# Copy built client
COPY --from=builder /app/client/dist ./client/dist

# Expose port
EXPOSE 4000

# Set data directory
ENV DATA_DIR=/app/server

# Start server
CMD ["pnpm", "start", "-w", "server"]
