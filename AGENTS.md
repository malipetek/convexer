# Convexer - Agent Documentation

## Project Overview
Convexer is a self-hosted Convex instance manager that allows users to create, manage, and monitor multiple Convex instances on a single server. It provides a web UI for managing instances, viewing metrics, and configuring subdomains.

## Tech Stack
- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS, shadcn/ui components
- **Backend**: Node.js, Express, TypeScript (run with tsx)
- **Database**: SQLite (stored in `/app/server/data`)
- **Containerization**: Docker, Docker Compose
- **Infrastructure**: Hetzner server, Cloudflare tunnel for external access
- **Package Manager**: npm (switched from pnpm due to Docker build issues)

## Architecture
```
/
├── client/          # React frontend
│   ├── src/
│   │   ├── components/  # UI components (InstanceCard, CreateDialog, etc.)
│   │   ├── pages/       # Page components (Home, Settings, InstanceDetail)
│   │   └── api.ts       # API client
│   └── package.json
├── server/          # Express backend
│   ├── src/
│   │   ├── index.ts     # Main server entry point
│   │   ├── routes.ts    # API routes
│   │   ├── docker.ts    # Docker container management
│   │   ├── tunnel.ts    # Cloudflare tunnel configuration
│   │   ├── auth.ts      # Authentication
│   │   └── types.ts     # TypeScript types
│   └── package.json
└── docker-compose.yml
```

## Key Features Implemented

### Instance Management
- Create, start, stop, delete Convex instances
- Auto-generate admin keys for each instance
- View instance logs (backend and dashboard)
- Live resource metrics (CPU, Memory, Disk)
- Historical metrics graphs
- PostgreSQL container management (create, start, stop, delete)
- PostgreSQL database operations (list tables, view schema, run SQL queries)
- Backup/restore PostgreSQL databases

### Subdomain Configuration
- Auto-generate random subdomains on instance creation (e.g., "swift-bear-123")
- Separate subdomains for instance backend and dashboard
- Custom subdomain configuration in instance settings
- Subdomain URLs displayed as clickable links in dashboard
- Global hostname setting in Settings page

### Authentication
- Password-based authentication via AUTH_PASSWORD env var
- Session tokens stored in SQLite
- Auth middleware on `/api` routes
- Public endpoints: `/api/login`, `/api/health`, `/api/version`, `/api/settings`

### App Updates
- Version tracking with semantic versioning (dynamically read from package.json)
- Check for updates endpoint (GitHub API integration)
- Update trigger endpoint (git pull + npm install + npm run build)
- Update UI in Settings page with release notes and download links

### Global Settings
- Hostname configuration (for subdomain URLs)
- Persisted via environment variable (DOMAIN)
- Settings API endpoints

## Critical Gotchas

### 🚨 Docker Volume Mount Issue (CRITICAL)
**Problem**: The Docker volume `convexer-data:/app/server` was mounting over the entire server directory, including source code. Every container start would shadow the new image code with old code from the volume.

**Solution**: Changed volume mount from `/app/server` to `/app/server/data`. Updated:
- `docker-compose.yml`: `convexer-data:/app/server/data`
- `Dockerfile`: `ENV DATA_DIR=/app/server/data`
- `docker-compose.yml`: `DATA_DIR=/app/server/data`

**Why this works**: The volume contains the SQLite database files at its root. When mounted at `/app/server/data`, they become accessible at `/app/server/data/convexer.db`. The source code from the image is no longer overwritten.

**When rebuilding**:
```bash
git pull origin main
docker compose down
docker compose build --no-cache
docker compose up -d
```

### Docker Build Issues with pnpm
**Problem**: npm workspaces with pnpm caused dependency hoisting issues, leading to broken styles in production builds.

**Solution**: Switched to npm for builds:
- Dockerfile uses `npm install` instead of `pnpm install`
- Client-specific dependencies moved from root `package.json` to `client/package.json`
- Build command: `npm run build --workspace=client`

### Public Endpoint Registration Order
**Problem**: Public endpoints (`/api/version`, `/api/settings`) registered AFTER the router would be blocked by auth middleware or shadowed by the router.

**Solution**: Register ALL public endpoints BEFORE `app.use('/api', router)` in `server/src/index.ts`. Also add paths to auth skip list:
```typescript
if (req.path.startsWith('/version') || req.path.startsWith('/settings')) return next();
```

### Extra Env JSON Parsing
**Problem**: `instance.extra_env` is stored as JSON string in database but needs to be parsed for use.

**Solution**: Always parse when accessing:
```typescript
const env = instance.extra_env ? JSON.parse(instance.extra_env) : {};
const subdomain = env.SUBDOMAIN || instance.name;
```

### Subdomain Generation in Tunnel Configuration
**Problem**: Tunnel configuration (`tunnel.ts`) was using `instance.name` instead of custom subdomains from `extra_env`.

**Solution**: Updated `getInstanceHostnames()` to parse `extra_env` and use custom subdomains:
```typescript
const env = JSON.parse(instance.extra_env || '{}');
const subdomain = env.SUBDOMAIN || instance.name;
const dashboardSubdomain = env.DASHBOARD_SUBDOMAIN || `${instance.name}-dash`;
```

### PostgreSQL SSL/TLS Configuration
**Problem**: Convex backend requires SSL when connecting to PostgreSQL by default, but the PostgreSQL container doesn't have TLS enabled, causing "server does not support TLS" errors.

**Solution**: Set `DO_NOT_REQUIRE_SSL=1` environment variable when creating the backend container. This tells the Convex backend to connect without SSL:
```typescript
backendEnv.push('DO_NOT_REQUIRE_SSL=1');
```

### PostgreSQL URL Format
**Problem**: Convex backend expects the PostgreSQL URL without the database name in the path - it adds the database name itself based on the instance name. Including it in the URL causes "cluster url already contains db name" errors.

**Solution**: Remove database name from POSTGRES_URL path:
```typescript
POSTGRES_URL=postgres://postgres:${password}@postgres-host:5432
```

### Auto-generated Subdomains Missing Domain Suffix
**Problem**: Auto-generated subdomains (BACKEND_DOMAIN, SITE_DOMAIN, DASHBOARD_DOMAIN) were set to just the instance name without the domain suffix (e.g., `t18` instead of `t18.malipetek.online`), causing 404 errors.

**Solution**: Include DOMAIN environment variable in auto-generated subdomains:
```typescript
const domain = process.env.DOMAIN || '';
finalExtraEnv.BACKEND_DOMAIN = domain ? `${instanceName}.${domain}` : instanceName;
```

## Deployment Details

### Server Environment
- Hetzner server at 178.104.170.215
- SSH alias: `ConvexerHetzner` in `~/.ssh/config`
- Project location: `/home/convexer`
- Deployment method: Docker Compose

### Environment Variables
```yaml
DATA_DIR=/app/server/data
DOMAIN=                    # Global hostname for subdomain URLs
TUNNEL_DOMAIN=             # Cloudflare tunnel domain
TUNNEL_CONFIG_PATH=        # Path to cloudflared config
AUTH_PASSWORD=             # Optional password protection
```

### Docker Compose Configuration
```yaml
services:
  convexer:
    build: .
    container_name: convexer
    restart: unless-stopped
    ports:
      - "80:4000"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - convexer-data:/app/server/data
```

### Cloudflare Tunnel
- Used for external access to instances
- Tunnel routes configured in `~/.cloudflared/config.yml`
- DNS records added automatically for new instances
- Subdomain-based routing: `{subdomain}.{TUNNEL_DOMAIN}`

## Common Issues and Fixes

### Version endpoint returns HTML
**Cause**: Old code running in container (volume shadowing issue) or endpoint not registered before router.
**Fix**: Ensure volume mount is `/app/server/data`, rebuild with `--no-cache`.

### Settings endpoint returns 404
**Cause**: Endpoint not registered before router or auth middleware blocking it.
**Fix**: Register endpoints before `app.use('/api', router)` and add to auth skip list.

### Styles broken in production
**Cause**: npm workspace dependency hoisting issues with pnpm.
**Fix**: Switch to npm, move client dependencies to `client/package.json`.

### Subdomain URLs not using custom values
**Cause**: Tunnel configuration not parsing `extra_env` JSON.
**Fix**: Update `getInstanceHostnames()` in `tunnel.ts` to parse `extra_env`.

### Instance creation fails
**Cause**: Docker daemon not accessible or network issues.
**Fix**: Ensure `/var/run/docker.sock` is mounted and `convexer-net` network exists.

## Development Workflow

### Local Development
```bash
# Install dependencies
npm install

# Start dev server (client on port 58420, server on 4000)
npm run dev

# Build for production
npm run build
```

### Making Changes
1. Make code changes locally
2. Test locally if possible
3. Commit and push to `origin/main`
4. SSH to server: `ssh ConvexerHetzner`
5. Pull and rebuild:
   ```bash
   cd /home/convexer
   git pull origin main
   docker compose down
   docker compose build --no-cache
   docker compose up -d
   ```

### Verifying Deployment
```bash
# Check container status
docker compose ps

# Check logs
docker compose logs -f

# Test version endpoint
curl -s http://localhost/api/version

# Test settings endpoint
curl -s http://localhost/api/settings
```

## Future Improvements
- Implement persistent hostname storage (currently only in process.env)
- Add health check improvements for Convex backend startup
- Implement proper database migrations
- Add monitoring and alerting
- Implement instance backup/restore functionality
