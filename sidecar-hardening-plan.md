# Better Auth Sidecar Reliability + Existing Container Updates

## Summary
- Make the Better Auth sidecar the source of truth for auth; Convex stores only app-level user references/claims.
- Fix the new-instance sidecar restart loop by creating/migrating Better Auth tables before any `ALTER TABLE` calls.
- Add an obvious UI path to detect and recreate stale/broken existing containers, including Better Auth sidecars.

## Key Changes
- **Sidecar schema startup**
  - Replace the partial `ensureBetterAuthSchema()` with an idempotent startup migration that creates `"user"`, `session`, `account`, `verification`, and `jwks` in dependency order.
  - Add missing columns/indexes with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`.
  - Keep snake_case field mapping, but support JWT plugin `jwks` camelCase columns because Better Auth’s JWT docs expect `publicKey`/`privateKey`.

- **Sidecar runtime hardening**
  - Attach the sidecar to `convexer-net` at container creation time via Docker networking config, not after `start()`.
  - Add Docker healthcheck against `/health`, wait for health in Convexer, and report sidecar status/restart count in the UI.
  - Generate and persist `BETTER_AUTH_SECRET` into `extra_env` when missing so recreating the sidecar does not rotate secrets unexpectedly.
  - Compute `BASE_URL`/`CONVEX_SITE_URL` from the actual Better Auth public domain, defaulting to `https://{instance}-auth.{DOMAIN}` unless explicitly overridden.
  - Replace `trustedOrigins: ['*']` with deterministic allowed origins: sidecar URL, backend URL, site URL, dashboard URL, and localhost dev URLs.

- **Convex integration model**
  - Better Auth owns users, sessions, accounts, OAuth, JWT/JWKS, and future auth plugins.
  - Convex consumes Better Auth JWTs; app documents reference Better Auth user IDs from JWT `sub` plus optional `email/name` claims.
  - Do not mirror users into Convex by default; add only optional app profile documents when the app needs app-specific metadata.

- **Existing container update flow**
  - Add `GET /api/instances/:id/container-updates` returning role, status, restart count, current image ID, target image ID, stale/broken boolean, and reason.
  - Add `POST /api/instances/:id/container-updates/apply` with `{ targetVersion: "latest", roles: ["backend","dashboard","betterauth"], backup: true }`.
  - Recreate only selected stale/broken roles; preserve volumes, ports, env, Traefik labels, and instance secrets.
  - Keep full backend/dashboard upgrades backed by pre-upgrade DB + volume backup; sidecar-only recreation requires DB backup only.

- **UI**
  - Move update status out of only `Settings`; show a visible “Container Updates” card in Overview and Containers tabs.
  - Show actionable states: `Current`, `Update available`, `Restarting`, `Broken`, `Missing`.
  - Add buttons: `Check`, `Update stale containers`, `Recreate Better Auth sidecar`, and `View logs`.

## Test Plan
- New instance with no Better Auth tables starts sidecar successfully and creates `"user"`, `session`, `account`, `verification`, `jwks`.
- Existing `assetmanagement` sidecar can be recreated without rotating `BETTER_AUTH_SECRET` and without losing users/sessions.
- Restart-looping `test` sidecar becomes healthy after recreation.
- Container update API detects stale backend/dashboard/sidecar image IDs and returns clear reasons.
- UI shows update availability on Overview without needing to know it lives under Settings.
- Run `pnpm exec tsc --noEmit -p server/tsconfig.json`, `pnpm --filter better-auth-sidecar build`, and `pnpm --filter convexer-client build`.

## Assumptions
- Use programmatic startup migration rather than a separate Better Auth CLI container, aligned with Better Auth’s documented migration/generate model: [CLI](https://better-auth.com/docs/concepts/cli), [Database](https://www.better-auth.com/docs/concepts/database).
- Keep the JWT plugin for Convex-facing auth tokens and JWKS verification, aligned with Better Auth JWT docs: [JWT](https://better-auth.com/docs/plugins/jwt).
- No automatic background updates yet; updates are explicit UI actions with logs and status.
