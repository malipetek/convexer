#!/usr/bin/env bash
set -euo pipefail

# Bump the app version, commit staged release files, push the tag, then publish Docker Hub images.
#
# Usage:
#   ./bump-and-push.sh [patch|minor|major|1.2.3] [--no-docker]
#
# Env passed through to scripts/publish-dockerhub.sh:
#   DOCKERHUB_NAMESPACE, APP_IMAGE_NAME, SIDECAR_IMAGE_NAME, PLATFORMS, BUILDER_NAME

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

BUMP="${1:-patch}"
PUBLISH_DOCKER=1

if [[ "${BUMP}" == "--no-docker" ]]; then
  BUMP="patch"
  PUBLISH_DOCKER=0
fi

if [[ "${2:-}" == "--no-docker" ]]; then
  PUBLISH_DOCKER=0
fi

CURRENT_VERSION="$(node -p "require('./package.json').version")"

NEW_VERSION="$(node - "$CURRENT_VERSION" "$BUMP" <<'NODE'
const [current, bump] = process.argv.slice(2);
const match = current.match(/^(\d+)\.(\d+)\.(\d+)$/);
if (!match) throw new Error(`Invalid current version: ${current}`);

if (/^\d+\.\d+\.\d+$/.test(bump)) {
  console.log(bump);
  process.exit(0);
}

const parts = current.split('.').map(Number);
if (bump === 'major') {
  parts[0] += 1;
  parts[1] = 0;
  parts[2] = 0;
} else if (bump === 'minor') {
  parts[1] += 1;
  parts[2] = 0;
} else if (bump === 'patch') {
  parts[2] += 1;
} else {
  throw new Error(`Unknown bump "${bump}". Use patch, minor, major, or an exact x.y.z version.`);
}
console.log(parts.join('.'));
NODE
)"

if git rev-parse "v${NEW_VERSION}" >/dev/null 2>&1; then
  echo "Tag v${NEW_VERSION} already exists locally" >&2
  exit 1
fi

if git ls-remote --exit-code --tags origin "refs/tags/v${NEW_VERSION}" >/dev/null 2>&1; then
  echo "Tag v${NEW_VERSION} already exists on origin" >&2
  exit 1
fi

node - "$NEW_VERSION" <<'NODE'
const fs = require('fs');
const version = process.argv[2];
const file = 'package.json';
const json = JSON.parse(fs.readFileSync(file, 'utf8'));
json.version = version;
fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
NODE

echo "==> Version: ${CURRENT_VERSION} -> ${NEW_VERSION}"

git add package.json bump-and-push.sh
git commit -m "chore: release v${NEW_VERSION}"
git tag "v${NEW_VERSION}"
git push origin HEAD:main "v${NEW_VERSION}"

if [[ "${PUBLISH_DOCKER}" == "1" ]]; then
  VERSION="${NEW_VERSION}" ./scripts/publish-dockerhub.sh
fi

echo "Released v${NEW_VERSION}"
