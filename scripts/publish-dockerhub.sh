#!/usr/bin/env bash
set -euo pipefail

# Publish Convexer runtime images to Docker Hub.
# Usage:
#   ./scripts/publish-dockerhub.sh
# Optional env:
#   DOCKERHUB_NAMESPACE=malipetek
#   APP_IMAGE_NAME=convexer
#   SIDECAR_IMAGE_NAME=convexer-better-auth-sidecar
#   VERSION=1.7.33
#   PLATFORMS=linux/amd64,linux/arm64
#   BUILDER_NAME=convexer-builder

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DOCKERHUB_NAMESPACE="${DOCKERHUB_NAMESPACE:-malipetek}"
APP_IMAGE_NAME="${APP_IMAGE_NAME:-convexer}"
SIDECAR_IMAGE_NAME="${SIDECAR_IMAGE_NAME:-convexer-better-auth-sidecar}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
BUILDER_NAME="${BUILDER_NAME:-convexer-builder}"
VERSION="${VERSION:-$(node -p "require('./package.json').version")}"

APP_IMAGE="${DOCKERHUB_NAMESPACE}/${APP_IMAGE_NAME}"
SIDECAR_IMAGE="${DOCKERHUB_NAMESPACE}/${SIDECAR_IMAGE_NAME}"

echo "==> Publishing images"
echo "App image:     ${APP_IMAGE}"
echo "Sidecar image: ${SIDECAR_IMAGE}"
echo "Version tag:   ${VERSION}"
echo "Platforms:     ${PLATFORMS}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "docker daemon is not running" >&2
  exit 1
fi

echo "==> Ensuring buildx builder"
docker buildx create --use --name "${BUILDER_NAME}" >/dev/null 2>&1 || docker buildx use "${BUILDER_NAME}" >/dev/null

echo "==> Building and pushing app image"
docker buildx build \
  --platform "${PLATFORMS}" \
  -t "${APP_IMAGE}:latest" \
  -t "${APP_IMAGE}:${VERSION}" \
  --push \
  .

echo "==> Building and pushing sidecar image"
docker buildx build \
  --platform "${PLATFORMS}" \
  --target betterauth-runtime \
  -t "${SIDECAR_IMAGE}:latest" \
  -t "${SIDECAR_IMAGE}:${VERSION}" \
  --push \
  .

echo "==> Done"
echo "Published:"
echo "  - ${APP_IMAGE}:latest"
echo "  - ${APP_IMAGE}:${VERSION}"
echo "  - ${SIDECAR_IMAGE}:latest"
echo "  - ${SIDECAR_IMAGE}:${VERSION}"
