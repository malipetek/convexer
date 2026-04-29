# Publish Convexer Images to Docker Hub

This guide publishes both runtime images used by the UI updater:

- `malipetek/convexer`
- `malipetek/convexer-better-auth-sidecar`

Run from repo root:

```bash
# 1) Login once
docker login

# 2) Ensure buildx builder exists
docker buildx create --use --name convexer-builder 2>/dev/null || docker buildx use convexer-builder

# 3) Use app version from package.json
VERSION=$(node -p "require('./package.json').version")

# 4) Push main app image (multi-arch)
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t malipetek/convexer:latest \
  -t malipetek/convexer:$VERSION \
  --push .

# 5) Push sidecar image (Dockerfile target)
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --target betterauth-runtime \
  -t malipetek/convexer-better-auth-sidecar:latest \
  -t malipetek/convexer-better-auth-sidecar:$VERSION \
  --push .
```

## Server configuration for image updater

Set these in your server `.env`:

```env
UPDATE_STRATEGY=image
CONVEXER_IMAGE=malipetek/convexer
BETTERAUTH_IMAGE=malipetek/convexer-better-auth-sidecar
```

Apply config:

```bash
docker compose up -d --build
```

After this, UI update can use `latest` or a specific version tag.
