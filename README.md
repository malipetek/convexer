# Convexer

Convexer is a self-hosted Convex instance manager inspired by Caprover. It runs in Docker, uses Traefik for subdomain routing with auto-HTTPS, and provides advanced configuration options for Convex self-hosting.

## Quick Start (Docker Compose)

The recommended deployment method is Docker Compose.

```bash
# Clone the repository
git clone <repo-url>
cd convexer

# Configure environment
cp .env.example .env
# Edit .env with your settings (DOMAIN, AUTH_PASSWORD, etc.)

# Start Convexer
docker compose up -d

# Access the UI at http://localhost:4000
```

## Environment Variables

- `DOMAIN` - Your domain for Traefik subdomain routing (e.g., `convex.example.com`)
  - When set, instances get `<name>.<domain>`, `<name>-site.<domain>`, `<name>-dash.<domain>`
  - Traefik will automatically obtain Let's Encrypt SSL certificates
- `AUTH_PASSWORD` - Optional password to protect the Convexer UI
- `TUNNEL_DOMAIN` - Optional Cloudflare tunnel domain (legacy)
- `TUNNEL_CONFIG_PATH` - Path to cloudflared config (legacy)

## Features

- **Docker-based deployment**: Manager runs in a container, manages sibling containers via mounted Docker socket
- **Traefik reverse proxy**: Automatic subdomain routing with Let's Encrypt SSL
- **Advanced Convex configuration**: Full access to official Convex self-hosting parameters
  - Document retention settings
  - Performance & concurrency tuning
  - Observability controls (metrics, logging, telemetry)
  - S3/MinIO storage configuration
  - Postgres/MySQL database options
  - Network settings
- **Live resource metrics**: CPU, memory, and disk usage per instance

## Architecture

- **Convexer manager**: Single container running Node.js + Express + React
- **Traefik**: Reverse proxy container for subdomain routing (auto-created)
- **Convex instances**: Per-instance backend + dashboard containers
- **Shared network**: All containers on `convexer-net` for internal communication

## Development

```bash
# Install dependencies
pnpm install

# Start development server
pnpm dev

# Build for production
pnpm build
```

## Legacy Deployment

PM2 configuration is provided in `ecosystem.config.cjs` for bare-metal deployments, but Docker Compose is the recommended path.
