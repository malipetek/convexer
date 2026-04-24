# E2E Tests

This suite uses Playwright with full UI flows plus API-assisted assertions.

## Default local mode

```bash
npm run test:e2e
```

Local mode automatically:

- brings up `e2e/docker-compose.e2e.yml`
- waits for `/api/health`
- runs the scenario
- tears down containers and volumes

## Remote mode

```bash
REMOTE_BASE_URL=http://your-fresh-server:4000 npm run test:e2e:remote
```

Remote mode does not manage Docker; it only runs tests against the provided base URL.

## Environment variables

- `E2E_AUTH_PASSWORD`: Password used for login checks. Defaults to `convexer-e2e-password`.
- `REMOTE_BASE_URL`: When set, enables remote mode.
- `E2E_HEADLESS`: Set to `false` to run headed.
