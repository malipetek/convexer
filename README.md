# Convexer

> Disclaimer: this project was vibe coded with SWE-1.6, Opus 4.5, Sonnet 4.6, and GPT-5.5. Treat it like useful self-hosting software, not a polished commercial control plane. Read the code, keep backups, and test upgrades before trusting important workloads to it.

Convexer is a self-hosted manager for running multiple Convex-based mobile backend bundles on one VPS. Each app instance can have its own Convex backend, Convex dashboard, PostgreSQL database, and Better Auth sidecar, while shared services such as Traefik, Umami, GlitchTip, backups, and push notification configuration live at the Convexer level to save server resources.

It is inspired by CapRover: you point a server at a domain, open a few ports, and manage app backends from a web dashboard.

## Features

- Create, start, stop, duplicate, archive, and restore Convex instances
- Per-instance Convex backend, dashboard, PostgreSQL database, and optional Better Auth sidecar
- PostgreSQL table browsing, schema inspection, SQL query execution, import/export, backup, and restore
- Scheduled local and remote backups
- Traefik-based subdomain routing through Docker labels
- Shared Umami analytics and GlitchTip error tracking containers
- Per-instance environment variable and subdomain configuration
- Per-instance health check timeout configuration
- Live CPU, memory, disk, and network metrics
- Self-update flow from GitHub releases
- Push notification gateway configuration scaffold for app backends

## Server Prerequisites

Recommended target:

- Fresh Ubuntu 22.04/24.04 or Debian 12 VPS
- Root access or a sudo-capable user
- 2 GB RAM minimum, 4 GB+ recommended
- 20 GB disk minimum, more if you keep local backups
- A domain pointing to the server
- Docker Engine with Docker Compose plugin
- Git and curl

The installer can install Docker, Git, curl, and ca-certificates on Debian/Ubuntu systems.

## Ports To Open

Open these inbound ports on your VPS firewall and cloud provider firewall:

- `22/tcp`: SSH
- `80/tcp`: HTTP, Traefik entrypoint and domain routing
- `443/tcp`: HTTPS entrypoint if you add TLS/cert resolver configuration
- `4000/tcp`: Convexer dashboard direct access

For a public production setup, you usually expose `80` and `443` publicly and restrict `4000` to your IP or VPN. The checked-in Compose file exposes `4000` for convenience.

## DNS

Point your root or management domain to the server:

```text
A     example.com        -> SERVER_IP
A     *.example.com      -> SERVER_IP
```

Convexer uses subdomains for instance endpoints. For an instance named `myapp`, the default domains are:

```text
myapp.example.com
myapp-site.example.com
myapp-dash.example.com
myapp-auth.example.com
```

## Quick Install

On a fresh server, run:

```bash
curl -fsSL https://raw.githubusercontent.com/malipetek/convexer/main/install.sh | sudo bash -s -- --domain example.com --password 'change-this-password'
```

Then open:

```text
http://example.com
```

Or, while DNS is still propagating:

```text
http://SERVER_IP:4000
```

### Installer Options

```bash
curl -fsSL https://raw.githubusercontent.com/malipetek/convexer/main/install.sh | sudo bash -s -- \
  --domain example.com \
  --password 'change-this-password' \
  --dir /home/convexer \
  --repo https://github.com/malipetek/convexer.git \
  --branch main
```

Options:

- `--domain`: required unless `DOMAIN` is already set
- `--password`: optional, sets `AUTH_PASSWORD`
- `--dir`: install directory, defaults to `/home/convexer`
- `--repo`: Git repository URL, defaults to this repo
- `--branch`: Git branch, defaults to `main`
- `--no-docker-install`: fail if Docker is missing instead of installing it

Environment variable equivalents are also supported:

```bash
sudo DOMAIN=example.com AUTH_PASSWORD='change-this-password' bash install.sh
```

## Manual Install

```bash
git clone https://github.com/malipetek/convexer.git /home/convexer
cd /home/convexer

cat > .env <<'EOF'
DOMAIN=example.com
AUTH_PASSWORD=change-this-password
HOST_PROJECT_PATH=/home/convexer
GITHUB_REPO=malipetek/convexer
UPDATE_BRANCH=main
EOF

docker network create convexer-net 2>/dev/null || true
docker compose up -d --build
```

Check status:

```bash
docker compose ps
docker compose logs -f convexer
curl -s http://localhost:4000/api/version
```

## Updating

Convexer includes a dashboard update flow that pulls from GitHub and rebuilds the app. You can also update manually:

```bash
cd /home/convexer
git pull --ff-only
docker compose up -d --build convexer
```

Important: Convexer data lives in Docker volumes. The core volumes are explicitly named:

```text
convexer-data
convexer-ssh
convexer-backups
```

Do not run `docker compose down -v` unless you intentionally want to remove persisted data.

## Backups

Convexer stores its own SQLite database at:

```text
/app/server/data/convexer.db
```

Inside Docker, this path is backed by the `convexer-data` volume.

Before major updates or migrations, make a host-side backup:

```bash
docker run --rm -v convexer-data:/data -v "$PWD:/backup" alpine \
  sh -lc 'tar czf /backup/convexer-data-backup-$(date +%Y%m%d-%H%M%S).tgz -C /data .'
```

Instance PostgreSQL data is stored in per-instance Docker volumes, for example:

```text
convexer-postgres-myapp
```

## Environment Variables

- `DOMAIN`: public hostname for Convexer and generated instance subdomains
- `AUTH_PASSWORD`: optional dashboard password
- `HOST_PROJECT_PATH`: absolute host path to the repo, used by the in-app updater
- `GITHUB_REPO`: GitHub repo slug used by version checking, for example `malipetek/convexer`
- `GITHUB_TOKEN`: optional token for private repos or higher GitHub API limits
- `UPDATE_BRANCH`: branch used by the updater, defaults to `main`
- `TUNNEL_DOMAIN`: optional legacy Cloudflare tunnel domain
- `TUNNEL_CONFIG_PATH`: optional legacy cloudflared config path

## Architecture

```text
convexer
  React dashboard + Express API
  SQLite metadata database
  Docker socket access for managing sibling containers

traefik
  Docker-label based routing for Convexer and app instances

per app instance
  Convex backend
  Convex dashboard
  PostgreSQL
  Better Auth sidecar

shared services
  Umami
  GlitchTip
  backup storage
  push notification gateway configuration
```

## Development

This repo currently has both npm and pnpm artifacts because production Docker builds use npm, while the local development environment may prefer pnpm.

```bash
pnpm install
pnpm dev
pnpm build
```

Server only:

```bash
pnpm -C server dev
```

Client only:

```bash
pnpm -C client dev
```

## Notes

- The current Traefik configuration defines HTTP and HTTPS entrypoints, but does not yet configure Let's Encrypt certificates in the checked-in Compose file.
- The Convexer container mounts `/var/run/docker.sock`, so anyone with dashboard access can indirectly control Docker on the host. Use a strong `AUTH_PASSWORD` and restrict access.
- Keep backups of `convexer-data` before updating.
