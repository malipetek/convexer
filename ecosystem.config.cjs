// LEGACY: PM2 configuration
// Primary deployment path is now Docker Compose (see docker-compose.yml)
// This config is kept for reference or bare-metal deployments
module.exports = {
  apps: [
    {
      name: 'convexer',
      script: 'server/src/index.ts',
      interpreter: 'node',
      interpreter_args: '--import tsx',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        PORT: 4000,
        TUNNEL_DOMAIN: 'malipetek.dev',
        AUTH_PASSWORD: 'capcapcap!!!',
      },
      restart_delay: 3000,
      max_restarts: 10,
      autorestart: true,
    },
  ],
};
