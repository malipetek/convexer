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
        TUNNEL_DOMAIN: 'deepturkishnews.live',
        AUTH_PASSWORD: 'capcapcap!!!',
      },
      restart_delay: 3000,
      max_restarts: 10,
      autorestart: true,
    },
  ],
};
