#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/malipetek/convexer.git}"
BRANCH="${BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-/home/convexer}"
DOMAIN="${DOMAIN:-}"
AUTH_PASSWORD="${AUTH_PASSWORD:-}"
INSTALL_DOCKER=1

usage() {
  cat <<'USAGE'
Convexer installer

Usage:
  sudo install.sh --domain example.com [options]

Options:
  --domain VALUE          Public domain for Convexer and instance subdomains.
  --password VALUE        Dashboard password. If omitted, dashboard auth is disabled.
  --dir VALUE             Install directory. Default: /home/convexer
  --repo VALUE            Git repository URL.
  --branch VALUE          Git branch. Default: main
  --no-docker-install     Do not install Docker automatically.
  -h, --help              Show this help.

Environment variables:
  DOMAIN, AUTH_PASSWORD, INSTALL_DIR, REPO_URL, BRANCH
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)
      DOMAIN="${2:-}"
      shift 2
      ;;
    --password)
      AUTH_PASSWORD="${2:-}"
      shift 2
      ;;
    --dir)
      INSTALL_DIR="${2:-}"
      shift 2
      ;;
    --repo)
      REPO_URL="${2:-}"
      shift 2
      ;;
    --branch)
      BRANCH="${2:-}"
      shift 2
      ;;
    --no-docker-install)
      INSTALL_DOCKER=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$DOMAIN" ]]; then
  echo "Missing required --domain value." >&2
  usage
  exit 1
fi

if [[ "$EUID" -ne 0 ]]; then
  echo "Please run this installer as root, for example:" >&2
  echo "  curl -fsSL https://raw.githubusercontent.com/malipetek/convexer/main/install.sh | sudo bash -s -- --domain ${DOMAIN}" >&2
  exit 1
fi

log() {
  printf '\n==> %s\n' "$1"
}

install_base_packages() {
  if command -v apt-get >/dev/null 2>&1; then
    log "Installing base packages"
    apt-get update
    apt-get install -y ca-certificates curl git
    return
  fi

  if command -v dnf >/dev/null 2>&1; then
    log "Installing base packages"
    dnf install -y ca-certificates curl git
    return
  fi

  if command -v yum >/dev/null 2>&1; then
    log "Installing base packages"
    yum install -y ca-certificates curl git
    return
  fi

  echo "Could not find apt-get, dnf, or yum. Please install curl and git manually." >&2
}

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log "Docker and Docker Compose plugin already installed"
    return
  fi

  if [[ "$INSTALL_DOCKER" -eq 0 ]]; then
    echo "Docker or Docker Compose plugin is missing." >&2
    exit 1
  fi

  if ! command -v apt-get >/dev/null 2>&1; then
    echo "Automatic Docker install currently supports Debian/Ubuntu apt systems only." >&2
    echo "Install Docker Engine and the Docker Compose plugin, then rerun with --no-docker-install." >&2
    exit 1
  fi

  log "Installing Docker"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc

  . /etc/os-release
  local repo_os="$ID"
  if [[ "$repo_os" == "debian" ]]; then
    curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  else
    repo_os="ubuntu"
  fi

  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${repo_os} \
    ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list

  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
}

clone_or_update_repo() {
  log "Preparing repository at ${INSTALL_DIR}"
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    git -C "$INSTALL_DIR" fetch origin "$BRANCH"
    git -C "$INSTALL_DIR" checkout "$BRANCH"
    git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
    return
  fi

  if [[ -e "$INSTALL_DIR" ]]; then
    echo "Install directory exists but is not a Git repository: $INSTALL_DIR" >&2
    exit 1
  fi

  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
}

write_env_file() {
  log "Writing .env"
  local repo_slug
  repo_slug="$(printf '%s' "$REPO_URL" | sed -E 's#^https://github.com/##; s#^git@github.com:##; s#\\.git$##')"

  cat > "$INSTALL_DIR/.env" <<EOF
DOMAIN=${DOMAIN}
AUTH_PASSWORD=${AUTH_PASSWORD}
HOST_PROJECT_PATH=${INSTALL_DIR}
GITHUB_REPO=${repo_slug}
GITHUB_TOKEN=
UPDATE_BRANCH=${BRANCH}
TUNNEL_DOMAIN=
TUNNEL_CONFIG_PATH=
EOF
}

start_stack() {
  log "Creating Docker network"
  docker network create convexer-net >/dev/null 2>&1 || true

  log "Starting Convexer"
  docker compose -f "$INSTALL_DIR/docker-compose.yml" --project-directory "$INSTALL_DIR" up -d --build
}

print_summary() {
  cat <<EOF

Convexer is installed.

Dashboard:
  http://${DOMAIN}
  http://SERVER_IP:4000

Install directory:
  ${INSTALL_DIR}

Useful commands:
  cd ${INSTALL_DIR}
  docker compose ps
  docker compose logs -f convexer

Remember to open inbound ports 80, 443, and 4000 as appropriate for your firewall policy.
EOF
}

install_base_packages
install_docker
clone_or_update_repo
write_env_file
start_stack
print_summary
