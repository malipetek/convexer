#!/bin/bash

# Bump version, commit all changes, and push with tag

# Read current version
CURRENT_VERSION=$(node -p "require('./package.json').version")

# Split version into parts
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"

# Increment patch version
NEW_PATCH=$((PATCH + 1))
NEW_VERSION="${MAJOR}.${MINOR}.${NEW_PATCH}"

# Update package.json
npm version "${NEW_VERSION}" --no-git-tag-version

# Commit all changes
git add -A
git commit -m "chore: bump version to ${NEW_VERSION}"

# Delete old tag and remote tag
git tag -d "v${CURRENT_VERSION}" 2>/dev/null || true
git push origin ":refs/tags/v${CURRENT_VERSION}" 2>/dev/null || true

# Create new tag
git tag "v${NEW_VERSION}"

# Push with tag
git push origin main --tags

echo "Version bumped from ${CURRENT_VERSION} to ${NEW_VERSION} and pushed with tag"
